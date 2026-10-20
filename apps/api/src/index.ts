/**
 * Process entry. Connects to the shared MongoDB and Redis used by the
 * matcher, then listens for the HTTP API. Redis is optional: without it
 * the process still serves history, and /v1/health reports degraded.
 */
import {MongoClient} from 'mongodb';
import Redis from 'ioredis';
import {buildApp} from './app';
import {loadConfig} from './config';
import {createMailer} from './mail';

async function main() {
  const config = loadConfig();
  const mongo = new MongoClient(config.mongodbUri);
  await mongo.connect();
  const db = mongo.db();

  let redis: Redis | null = null;
  const client = new Redis(config.redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
  });
  try {
    await client.connect();
    redis = client;
  } catch (err) {
    console.error('Redis unavailable; live spot stream will be disabled', err);
    client.disconnect();
  }

  const app = await buildApp({config, db, redis, mailer: createMailer(config)}, {logger: true});
  await app.listen({host: config.host, port: config.port});

  const shutdown = async () => {
    await app.close();
    if (redis) redis.disconnect();
    await mongo.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
