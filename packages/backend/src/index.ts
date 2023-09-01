/*
 * Hi!
 *
 * Note that this is an EXAMPLE Backstage backend. Please check the README.
 *
 * Happy hacking!
 */

import Router from 'express-promise-router';
import {
  createServiceBuilder,
  loadBackendConfig,
  getRootLogger,
  useHotMemoize,
  notFoundHandler,
  CacheManager,
  DatabaseManager,
  HostDiscovery,
  UrlReaders,
  ServerTokenManager,
} from '@backstage/backend-common';
import { TaskScheduler } from '@backstage/backend-tasks';
import { Config } from '@backstage/config';
import app from './plugins/app';
import auth from './plugins/auth';
import catalog from './plugins/catalog';
import scaffolder from './plugins/scaffolder';
import proxy from './plugins/proxy';
import techdocs from './plugins/techdocs';
import search from './plugins/search';
import kubernetes from './plugins/kubernetes';
import argocd from './plugins/argocd';
import ocm from './plugins/ocm';

import { PluginEnvironment } from './types';
import { ServerPermissionClient } from '@backstage/plugin-permission-node';
import { DefaultIdentityClient } from '@backstage/plugin-auth-node';

function makeCreateEnv(config: Config) {
  const root = getRootLogger();
  const reader = UrlReaders.default({ logger: root, config });
  const discovery = HostDiscovery.fromConfig(config);
  const cacheManager = CacheManager.fromConfig(config);
  const databaseManager = DatabaseManager.fromConfig(config, { logger: root });
  const tokenManager = ServerTokenManager.noop();
  const taskScheduler = TaskScheduler.fromConfig(config);

  const identity = DefaultIdentityClient.create({
    discovery,
  });
  const permissions = ServerPermissionClient.fromConfig(config, {
    discovery,
    tokenManager,
  });

  root.info(`Created UrlReader ${reader}`);

  return (plugin: string): PluginEnvironment => {
    const logger = root.child({ type: 'plugin', plugin });
    const database = databaseManager.forPlugin(plugin);
    const cache = cacheManager.forPlugin(plugin);
    const scheduler = taskScheduler.forPlugin(plugin);
    return {
      logger,
      database,
      cache,
      config,
      reader,
      discovery,
      tokenManager,
      scheduler,
      permissions,
      identity,
    };
  };
}

type AddPluginBase = {
  isOptional?: boolean;
  plugin: string;
  apiRouter: ReturnType<typeof Router>;
  createEnv: ReturnType<typeof makeCreateEnv>;
  router: (env: PluginEnvironment) => Promise<ReturnType<typeof Router>>;
  options?: { path?: string };
};

type AddPlugin = {
  isOptional?: false;
} & AddPluginBase;

type AddOptionalPlugin = {
  isOptional: true;
  config: Config;
  options?: { key?: string; path?: string };
} & AddPluginBase;

async function addPlugin(args: AddPlugin | AddOptionalPlugin): Promise<void> {
  const { isOptional, plugin, apiRouter, createEnv, router, options } = args;

  const isPluginEnabled =
    !isOptional ||
    args.config.getOptionalBoolean(options?.key ?? `enabled.${plugin}`) ||
    false;
  if (isPluginEnabled) {
    const pluginEnv: PluginEnvironment = useHotMemoize(module, () =>
      createEnv(plugin),
    );
    apiRouter.use(options?.path ?? `/${plugin}`, await router(pluginEnv));
    console.log(`Using backend plugin ${plugin}...`);
  }
}

async function main() {
  const config = await loadBackendConfig({
    argv: process.argv,
    logger: getRootLogger(),
  });
  const createEnv = makeCreateEnv(config);
  const appEnv = useHotMemoize(module, () => createEnv('app'));
  const apiRouter = Router();

  // Required plugins
  await addPlugin({ plugin: 'proxy', apiRouter, createEnv, router: proxy });
  await addPlugin({ plugin: 'auth', apiRouter, createEnv, router: auth });
  await addPlugin({ plugin: 'catalog', apiRouter, createEnv, router: catalog });
  await addPlugin({ plugin: 'search', apiRouter, createEnv, router: search });
  await addPlugin({
    plugin: 'scaffolder',
    apiRouter,
    createEnv,
    router: scaffolder,
  });
  // Optional plugins
  await addPlugin({
    plugin: 'techdocs',
    config,
    apiRouter,
    createEnv,
    router: techdocs,
    isOptional: true,
  });
  await addPlugin({
    plugin: 'argocd',
    config,
    apiRouter,
    createEnv,
    router: argocd,
    isOptional: true,
  });
  await addPlugin({
    plugin: 'kubernetes',
    config,
    apiRouter,
    createEnv,
    router: kubernetes,
    isOptional: true,
  });
  await addPlugin({
    plugin: 'ocm',
    config,
    apiRouter,
    createEnv,
    router: ocm,
    isOptional: true,
  });

  // Add backends ABOVE this line; this 404 handler is the catch-all fallback
  apiRouter.use(notFoundHandler());

  const service = createServiceBuilder(module)
    .loadConfig(config)
    .addRouter('/api', apiRouter)
    .addRouter('', await app(appEnv));

  await service.start().catch(err => {
    console.log(err);
    process.exit(1);
  });
}

module.hot?.accept();
main().catch(error => {
  console.error('Backend failed to start up', error);
  process.exit(1);
});
