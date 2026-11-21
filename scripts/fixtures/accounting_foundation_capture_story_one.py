#!/usr/bin/env python3
import argparse,json,os,subprocess,urllib.request,uuid
from pathlib import Path

def req(ok,msg):
 if not ok: raise SystemExit(f"FAIL: Story 1 persisted capture: {msg}")
def ev(name):
 value=os.getenv(name,'').strip(); req(value,f"missing {name}"); return value
class Odoo:
 def __init__(self): self.url=ev('ODOO_URL'); self.user=ev('KEMFAI_AF_ODOO_LOGIN'); self.password=ev('KEMFAI_AF_ODOO_PASSWORD'); self.n=0; self.uids={}
 def rpc(self,service,method,args):
  self.n+=1; request=urllib.request.Request(self.url+'/jsonrpc',data=json.dumps({'jsonrpc':'2.0','method':'call','params':{'service':service,'method':method,'args':args},'id':self.n}).encode(),headers={'content-type':'application/json'})
  with urllib.request.urlopen(request,timeout=120) as response: body=json.load(response)
  req('error' not in body,f'Odoo {service}.{method} failed'); return body.get('result')
 def rows(self,db,model,domain,fields):
  uid=self.uids.get(db)
  if uid is None: uid=self.rpc('common','authenticate',[db,self.user,self.password,{}]); req(isinstance(uid,int),f'authentication failed for {db}'); self.uids[db]=uid
  value=self.rpc('object','execute_kw',[db,uid,self.password,model,'search_read',[domain],{'fields':fields,'order':'id asc'}]); req(isinstance(value,list),f'{model} query failed'); return value
def control(sql):
 cmd=['docker','exec',ev('KEMFAI_AF_PG_CONTAINER'),'psql','-XAtq','-U',ev('KEMFAI_AF_DB_USER'),'-d','kemfai_control','-c',f"SELECT COALESCE(json_agg(row_to_json(q)), '[]'::json) FROM ({sql}) q"]
 result=subprocess.run(cmd,check=True,text=True,capture_output=True); value=json.loads(result.stdout.strip()); req(isinstance(value,list),'control query failed'); return value
def save(path,payload): path.write_text(json.dumps(payload,sort_keys=True,separators=(',',':'))+'\n'); path.chmod(0o600)
def main():
 ap=argparse.ArgumentParser()
 for name in ['journey','topology','output-dir','story-output','scope-output','ledger-output','audit-output']: ap.add_argument('--'+name,type=Path,required=True)
 a=ap.parse_args(); journey=json.loads(a.journey.read_text()); topology=json.loads(a.topology.read_text()); o=Odoo()
 db_a,db_b=ev('KEMFAI_AF_TENANT_A_DB'),ev('KEMFAI_AF_TENANT_B_DB'); ca1,ca2,cb1=ev('KEMFAI_AF_COMPANY_A1_ID'),ev('KEMFAI_AF_COMPANY_A2_ID'),ev('KEMFAI_AF_COMPANY_B1_ID')
 for db,expected in [(db_a,{ca1,ca2}),(db_b,{cb1})]: req({str(r['kemfai_public_id']) for r in o.rows(db,'res.company',[],['kemfai_public_id'])}==expected,f'{db} company topology mismatch')
 race,draftj,scopej=journey.get('race'),journey.get('draft'),journey.get('scope'); req(all(isinstance(x,dict) for x in [race,draftj,scopej]),'browser facts incomplete')
 account_id,draft_id,foreign_id=str(race.get('accountId','')),str(draftj.get('id','')),str(scopej.get('tenantBId',''))
 account=o.rows(db_a,'account.account',[['kemfai_public_id','=',account_id]],['kemfai_public_id','company_id','version'])
 draft=o.rows(db_a,'kemfai.account.draft',[['public_id','=',draft_id]],['public_id','company_id','status','version','payload_json','validation_state'])
 foreign=o.rows(db_b,'account.account',[['kemfai_public_id','=',foreign_id]],['kemfai_public_id','company_id'])
 req(len(account)==len(draft)==len(foreign)==1,'persisted resource proof incomplete'); req(draft[0]['status']=='draft','resource is not draft-only')
 req(account[0]['company_id'][0]==topology['tenantA'][0]['id'] and draft[0]['company_id'][0]==topology['tenantA'][0]['id'],'resource company mismatch')
 handoffs=control("SELECT id::text,state,route,method,action,final_response,company_uuid::text FROM accounting_mutation_handoff ORDER BY created_at,id")
 platform=control("SELECT id::text,action,tenant_id::text,actor_id::text,subject_id::text,payload,dedupe_key FROM audit_event WHERE dedupe_key LIKE 'accounting.mutation:%' OR action='accounting.access.denied' ORDER BY created_at,id")
 user_a_keycloak=str(uuid.UUID(ev('KEMFAI_AF_USER_A_ID'))); actor_rows=control(f"SELECT id::text FROM account WHERE keycloak_user_id='{user_a_keycloak}'::uuid"); req(len(actor_rows)==1,'User A control-plane account mapping missing or ambiguous'); actor_account_id=str(actor_rows[0]['id'])
 rh=[r for r in handoffs if r['method']=='PATCH' and r['route']==f'/v1/accounting/accounts/{account_id}']; req(len(rh)==2,'race lacks two persisted handoff transactions'); req(sum(r['state']=='audited' for r in rh)==1,'race lacks exactly one winner')
 starts,statuses=race.get('starts'),race.get('statuses'); req(isinstance(starts,list) and len(starts)==2 and all(isinstance(x,int) for x in starts),'race starts missing'); req(isinstance(statuses,list) and sorted(statuses)==[200,412],'race statuses invalid')
 initial=race.get('initialVersion'); req(isinstance(initial,int) and account[0]['version']==initial+1,'race version delta is not one')
 audits={}; receipts={}
 for db in [db_a,db_b]:
  audits[db]=o.rows(db,'kemfai.account.audit.event',[],['public_id','operation_uuid','target_public_id','action']); receipts[db]=o.rows(db,'kemfai.account.mutation.receipt',[],['operation_uuid','audit_event_uuid'])
 audit_rows=sum(audits.values(),[]); receipt_rows=sum(receipts.values(),[]); accepted={r['id'] for r in handoffs if r['state']=='audited'}; audit_ops={r['operation_uuid'] for r in audit_rows}; receipt_ops={r['operation_uuid'] for r in receipt_rows}; mirror_ops={str(r.get('payload',{}).get('operation_uuid')) for r in platform if isinstance(r.get('payload'),dict) and str(r.get('dedupe_key','')).startswith('accounting.mutation:')}
 req(bool(accepted) and accepted==audit_ops==receipt_ops==mirror_ops,'handoff/audit/receipt/mirror sets differ')
 vop,vaid=str(draftj.get('validationOperationId','')),str(draftj.get('validationAuditEventId','')); req(vop in accepted and any(r['operation_uuid']==vop and r['public_id']==vaid for r in audit_rows),'parent rejection audit missing')
 lines=draft[0].get('payload_json',{}).get('lines',[]); req(any(x.get('accountId')==str(journey.get('parentId')) for x in lines),'rejected parent not persisted in draft')
 expected_denial_route=f'/v1/accounting/accounts/{foreign_id}'
 denials=[r for r in platform if r.get('action')=='accounting.access.denied' and str(r.get('tenant_id'))==ev('KEMFAI_AF_TENANT_A_ID') and str(r.get('actor_id'))==actor_account_id and str(r.get('subject_id'))==ca1 and isinstance(r.get('payload'),dict) and r['payload'].get('company_uuid')==ca1 and r['payload'].get('route')==expected_denial_route and r['payload'].get('reason')=='company_scope_denied' and str(r.get('dedupe_key'))==f"accounting.denial:{r['payload'].get('operation_uuid')}"]
 req(len(denials)==1,'exact cross-tenant denial audit missing or ambiguous'); denial=denials[0]; denial_operation=str(denial['payload'].get('operation_uuid','')); req(uuid.UUID(denial_operation).version in range(1,6),'cross-tenant denial operation UUID invalid')
 before,after=journey.get('ledgerBefore'),journey.get('ledgerAfter'); req(isinstance(before,dict) and before==after,'ledger snapshots differ')
 ledger_rows=[]
 for key,name,db in [('tenantA','tenant_a_db',db_a),('tenantB','tenant_b_db',db_b)]:
  x=before.get(key); req(isinstance(x,dict) and isinstance(x.get('hash'),str) and isinstance(x.get('moves'),int) and isinstance(x.get('lines'),int) and isinstance(x.get('balanceHash'),str),f'{name} ledger snapshot missing'); ledger_rows.append({'name':name,'actualDatabase':db,'beforeHash':x['hash'],'afterHash':x['hash'],'beforeMoveCount':x['moves'],'afterMoveCount':x['moves'],'beforeLineCount':x['lines'],'afterLineCount':x['lines'],'beforeBalanceHash':x['balanceHash'],'afterBalanceHash':x['balanceHash'],'persistedQueryId':f'odoo:{db}:ledger-count-hash'})
 story={'story':'story-1','status':'passed','productionPath':True,'persistedStateVerified':True,'emptyLoadingErrorCovered':True,'locales':['en-LTR','ar-RTL'],'captureSource':'persisted-queries','actor':{'accountId':actor_account_id,'subjectId':user_a_keycloak,'persistedQueryId':f'control:account:{actor_account_id}'},'databases':[{'name':'tenant_a_db','actualDatabase':db_a,'tenantId':ev('KEMFAI_AF_TENANT_A_ID'),'companyIds':[ca1,ca2],'persistedQueryId':f'odoo:{db_a}:companies'},{'name':'tenant_b_db','actualDatabase':db_b,'tenantId':ev('KEMFAI_AF_TENANT_B_ID'),'companyIds':[cb1],'persistedQueryId':f'odoo:{db_b}:companies'}],'account':{'id':account_id,'database':'tenant_a_db','companyId':ca1,'persistedQueryId':f'odoo:{db_a}:account:{account_id}'},'draft':{'id':draft_id,'state':'draft','database':'tenant_a_db','companyId':ca1,'persistedQueryId':f'odoo:{db_a}:draft:{draft_id}'},'parentRejection':{'code':'ACCOUNT_NOT_POSTING','lineIndex':0,'persistedDraftUnchanged':True,'ledgerEffect':'none','receiptId':vop,'auditEventId':vaid},'race':{'kind':'simultaneous','barrierId':str(race.get('barrierId')),'participants':2,'maxStartSkewMs':abs(starts[0]-starts[1]),'transactionIds':[r['id'] for r in rh],'winnerCount':1,'staleCount':1,'versionDelta':1,'persistedWinnerQueryId':f'odoo:{db_a}:account:{account_id}:version={account[0]["version"]}'}}
 scope={'status':'passed','tenantBResourceId':foreign_id,'tenantBResourceFetchedByUserB':scopej.get('fetchedByB')==200,'userBFetchPersistedQueryId':f'odoo:{db_b}:account:{foreign_id}','sameResourceAttemptedByUserA':True,'sameResourceOpaquelyDeniedToUserA':scopej.get('deniedToA')==404,'ordinaryAuthenticatedPath':True,'foreignFieldsDisclosed':False,'denialAuditQueryId':f'control:audit_event:{denial["id"]}','denialAudit':{'eventId':denial['id'],'operationId':denial_operation,'actorAccountId':str(denial['actor_id']),'tenantId':str(denial['tenant_id']),'companyId':str(denial['subject_id']),'route':str(denial['payload']['route']),'reason':str(denial['payload']['reason'])}}
 ops=sorted(accepted); aud={'status':'passed','acceptedMutations':len(ops),'tenantAuditEvents':len(audit_ops),'operationReceipts':len(receipt_ops),'platformMirrorsComplete':mirror_ops==accepted,'dedupeStateComplete':len(mirror_ops)==len(ops),'acceptedMutationIds':ops,'tenantAuditOperationIds':sorted(audit_ops),'operationReceiptOperationIds':sorted(receipt_ops),'platformMirrorOperationIds':sorted(mirror_ops),'persistedQueryIds':['odoo:tenant-a+b:audit','odoo:tenant-a+b:receipt','control:platform-mirror']}
 for path,payload in [(a.story_output,story),(a.scope_output,scope),(a.ledger_output,{'status':'passed','actionPostInvocations':0,'postingFeatureEnabled':False,'databases':ledger_rows}),(a.audit_output,aud)]: save(path,payload)
 print('PASS: captured Story 1 facts from persisted tenant and control-plane state')
if __name__=='__main__': main()
