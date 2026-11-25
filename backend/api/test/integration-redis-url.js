"use strict";

const INTEGRATION_REDIS_DB = 14;

function integrationRedisUrl(value = process.env.REDIS_URL || "redis://localhost:6379") {
  const url = new URL(value);
  url.pathname = `/${INTEGRATION_REDIS_DB}`;
  return url.toString();
}

module.exports = { INTEGRATION_REDIS_DB, integrationRedisUrl };
