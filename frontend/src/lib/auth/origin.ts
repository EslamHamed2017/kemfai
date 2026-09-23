export function hasSameOrigin(request: Request, publicOrigin: string): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(publicOrigin).origin;
  } catch {
    return false;
  }
}
