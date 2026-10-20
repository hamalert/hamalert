/**
 * Fastify application. Every route module is mounted under /v1; the path
 * comments in src/routes name the full URL each handler serves.
 */
import cors from '@fastify/cors';
import Fastify, {type FastifyInstance} from 'fastify';
import {ApiError} from './errors';
import {ensureSessionIndexes} from './auth/sessions';
import {authenticate, sendError, type AppDeps} from './http';
import {registerAccount, registerAuth} from './routes/auth';
import {registerPublic, registerReference} from './routes/reference';
import {registerDestinations, registerDevices, registerLimits} from './routes/settings';
import {registerSimulate, registerSpots} from './routes/spots';
import {registerMutes, registerTriggers} from './routes/triggers';

export async function buildApp(deps: AppDeps, opts: {logger?: boolean} = {}): Promise<FastifyInstance> {
  const app = Fastify({
    trustProxy: deps.config.trustProxy,
    logger: opts.logger ?? false,
  });
  app.decorate('deps', deps);
  app.decorate('authenticate', authenticate);
  await app.register(cors, {origin: deps.config.corsOrigins});
  app.setErrorHandler((err, req, reply) => {
    if (reply.sent) return;
    if (err instanceof ApiError) return sendError(reply, err, req.url);
    req.log.error(err);
    const wrapped = new ApiError(500, 'Internal Server Error', {detail: 'Unexpected error'});
    return sendError(reply, wrapped, req.url);
  });
  app.setNotFoundHandler((req, reply) => {
    sendError(reply, new ApiError(404, 'Not Found', {detail: 'No such endpoint'}), req.url);
  });

  await ensureSessionIndexes(deps.db);
  await app.register(async (api) => {
    registerAuth(api);          // /auth/login, refresh, logout, sessions, register/captcha, register, password
    registerAccount(api);       // /account, /account/password, /account/email, /account/clublog
    registerDestinations(api);  // /account/destinations, threema verify
    registerDevices(api);       // /devices
    registerLimits(api);        // /account/limits, /account/blocked-spotters
    registerTriggers(api);      // /triggers and the two trigger helpers
    registerMutes(api);         // /mutes
    registerSpots(api);         // /spots, /spots/stream, /spots/badge
    registerSimulate(api);      // /simulate
    registerReference(api);     // /reference/*
    registerPublic(api);        // /public/*, /health
  }, {prefix: '/v1'});

  return app;
}
