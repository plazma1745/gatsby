import _ from "lodash"
import { slash, isCI } from "gatsby-core-utils"
import fs from "fs-extra"
import md5File from "md5-file"
import crypto from "crypto"
import del from "del"
import path from "path"
import telemetry from "gatsby-telemetry"

import apiRunnerNode from "../utils/api-runner-node"
import handleFlags from "../utils/handle-flags"
import { getBrowsersList } from "../utils/browserslist"
import { showExperimentNoticeAfterTimeout } from "../utils/show-experiment-notice"
import sampleSiteForExperiment from "../utils/sample-site-for-experiment"
import { Store, AnyAction } from "redux"
import { preferDefault } from "../bootstrap/prefer-default"
import * as WorkerPool from "../utils/worker/pool"
import JestWorker from "jest-worker"
import { startPluginRunner } from "../redux/plugin-runner"
import { loadPlugins } from "../bootstrap/load-plugins"
import { store, emitter } from "../redux"
import loadThemes from "../bootstrap/load-themes"
import reporter from "gatsby-cli/lib/reporter"
import { getReactHotLoaderStrategy } from "../utils/get-react-hot-loader-strategy"
import { getConfigFile } from "../bootstrap/get-config-file"
import { removeStaleJobs } from "../bootstrap/remove-stale-jobs"
import { IPluginInfoOptions } from "../bootstrap/load-plugins/types"
import { internalActions } from "../redux/actions"
import { IGatsbyState } from "../redux/types"
import { IBuildContext } from "./types"

interface IPluginResolution {
  resolve: string
  options: IPluginInfoOptions
}

// If the env variable GATSBY_EXPERIMENTAL_FAST_DEV is set, enable
// all DEV experimental changes (but only during development & not on CI).
if (
  process.env.gatsby_executing_command === `develop` &&
  process.env.GATSBY_EXPERIMENTAL_FAST_DEV &&
  !isCI()
) {
  process.env.GATSBY_EXPERIMENTAL_LAZY_IMAGES = `true`
  process.env.GATSBY_EXPERIMENTAL_QUERY_ON_DEMAND = `true`
  process.env.GATSBY_EXPERIMENTAL_DEV_SSR = `true`

  reporter.info(`
Three fast dev experiments are enabled: Query on Demand, Development SSR, and Lazy Images (only with gatsby-plugin-sharp@^2.10.0).

Please give feedback on their respective umbrella issues!

- https://gatsby.dev/query-on-demand-feedback
- https://gatsby.dev/dev-ssr-feedback
- https://gatsby.dev/lazy-images-feedback
  `)

  telemetry.trackFeatureIsUsed(`FastDev`)
}

if (
  process.env.gatsby_executing_command === `develop` &&
  !process.env.GATSBY_EXPERIMENTAL_DEV_SSR &&
  !isCI() &&
  sampleSiteForExperiment(`DEV_SSR`, 5)
) {
  showExperimentNoticeAfterTimeout(
    `Server Side Rendering (SSR) in Development`,
    `gatsby.dev/dev-ssr-feedback`,
    `which helps surface issues with build errors more quickly. Here's how to try it:

module.exports = {
  flags : { DEV_SSR: true },
  plugins: [...]
}`,
    1 // Show this immediately to the subset of sites selected.
  )
}

// Show stack trace on unhandled promises.
process.on(`unhandledRejection`, (reason: unknown) => {
  // https://github.com/DefinitelyTyped/DefinitelyTyped/issues/33636
  reporter.panic((reason as Error) || `Unhandled rejection`)
})

// Override console.log to add the source file + line number.
// Useful for debugging if you lose a console.log somewhere.
// Otherwise leave commented out.
// require(`../bootstrap/log-line-function`)

export async function initialize({
  program: args,
  parentSpan,
}: IBuildContext): Promise<{
  store: Store<IGatsbyState, AnyAction>
  workerPool: JestWorker
}> {
  if (!args) {
    reporter.panic(`Missing program args`)
  }

  /* Time for a little story...
   * When running `gatsby develop`, the globally installed gatsby-cli starts
   * and sets up a Redux store (which is where logs are now stored). When gatsby
   * finds your project's locally installed gatsby-cli package in node_modules,
   * it switches over. This instance will have a separate redux store. We need to
   * ensure that the correct store is used which is why we call setStore
   * (/packages/gatsby-cli/src/reporter/redux/index.js)
   *
   * This function
   * - copies over the logs from the global gatsby-cli to the local one
   * - sets the store to the local one (so that further actions dispatched by
   * the global gatsby-cli are handled by the local one)
   */
  if (args.setStore) {
    args.setStore(store)
  }

  // Start plugin runner which listens to the store
  // and invokes Gatsby API based on actions.
  startPluginRunner()

  const directory = slash(args.directory)

  const program = {
    ...args,
    browserslist: getBrowsersList(directory),
    // Fix program directory path for windows env.
    directory,
  }

  store.dispatch({
    type: `SET_PROGRAM`,
    payload: program,
  })

  let activityForJobs

  emitter.on(`CREATE_JOB`, () => {
    if (!activityForJobs) {
      activityForJobs = reporter.phantomActivity(`Running jobs`)
      activityForJobs.start()
    }
  })

  const onEndJob = (): void => {
    if (activityForJobs && store.getState().jobs.active.length === 0) {
      activityForJobs.end()
      activityForJobs = null
    }
  }

  emitter.on(`END_JOB`, onEndJob)

  // Try opening the site's gatsby-config.js file.
  let activity = reporter.activityTimer(`open and validate gatsby-configs`, {
    parentSpan,
  })
  activity.start()
  const { configModule, configFilePath } = await getConfigFile(
    program.directory,
    `gatsby-config`
  )
  let config = preferDefault(configModule)

  // The root config cannot be exported as a function, only theme configs
  if (typeof config === `function`) {
    reporter.panic({
      id: `10126`,
      context: {
        configName: `gatsby-config`,
        path: program.directory,
      },
    })
  }

  // Setup flags
  if (config && config.flags) {
    // TODO: this should be handled in FAST_REFRESH configuration and not be one-off here.
    if (
      config.flags.FAST_REFRESH &&
      process.env.GATSBY_HOT_LOADER &&
      process.env.GATSBY_HOT_LOADER !== `fast-refresh`
    ) {
      delete config.flags.FAST_REFRESH
      reporter.warn(
        reporter.stripIndent(`
          Both FAST_REFRESH gatsby-config flag and GATSBY_HOT_LOADER environment variable is used with conflicting setting ("${process.env.GATSBY_HOT_LOADER}").
          
          Will use react-hot-loader.
          
          To use Fast Refresh either do not use GATSBY_HOT_LOADER environment variable or set it to "fast-refresh".
        `)
      )
    }
    const availableFlags = require(`../utils/flags`).default
    // Get flags
    const { enabledConfigFlags, unknownFlagMessage, message } = handleFlags(
      availableFlags,
      config.flags
    )

    if (unknownFlagMessage !== ``) {
      reporter.warn(unknownFlagMessage)
    }

    //  set process.env for each flag
    enabledConfigFlags.forEach(flag => {
      process.env[flag.env] = `true`
    })

    // Print out message.
    if (message !== ``) {
      reporter.info(message)
    }

    //  track usage of feature
    enabledConfigFlags.forEach(flag => {
      telemetry.trackFeatureIsUsed(flag.telemetryId)
    })

    // Track the usage of config.flags
    if (enabledConfigFlags.length > 0) {
      telemetry.trackFeatureIsUsed(`ConfigFlags`)
    }
  }

  process.env.GATSBY_HOT_LOADER = getReactHotLoaderStrategy()

  // theme gatsby configs can be functions or objects
  if (config && config.__experimentalThemes) {
    reporter.warn(
      `The gatsby-config key "__experimentalThemes" has been deprecated. Please use the "plugins" key instead.`
    )
    const themes = await loadThemes(config, {
      useLegacyThemes: true,
      configFilePath,
      rootDir: program.directory,
    })
    config = themes.config

    store.dispatch({
      type: `SET_RESOLVED_THEMES`,
      payload: themes.themes,
    })
  } else if (config) {
    const plugins = await loadThemes(config, {
      useLegacyThemes: false,
      configFilePath,
      rootDir: program.directory,
    })
    config = plugins.config
  }

  if (config && config.polyfill) {
    reporter.warn(
      `Support for custom Promise polyfills has been removed in Gatsby v2. We only support Babel 7's new automatic polyfilling behavior.`
    )
  }

  store.dispatch(internalActions.setSiteConfig(config))

  activity.end()

  if (process.env.GATSBY_EXPERIMENTAL_QUERY_ON_DEMAND) {
    if (process.env.gatsby_executing_command !== `develop`) {
      // we don't want to ever have this flag enabled for anything than develop
      // in case someone have this env var globally set
      delete process.env.GATSBY_EXPERIMENTAL_QUERY_ON_DEMAND
    } else if (isCI()) {
      delete process.env.GATSBY_EXPERIMENTAL_QUERY_ON_DEMAND
      reporter.warn(
        `Experimental Query on Demand feature is not available in CI environment. Continuing with regular mode.`
      )
    } else {
      // We already show a notice for this flag.
      if (!process.env.GATSBY_EXPERIMENTAL_FAST_DEV) {
        reporter.info(`Using experimental Query on Demand feature`)
      }
      telemetry.trackFeatureIsUsed(`QueryOnDemand`)
    }
  }

  // run stale jobs
  store.dispatch(removeStaleJobs(store.getState()))

  activity = reporter.activityTimer(`load plugins`, {
    parentSpan,
  })
  activity.start()
  const flattenedPlugins = await loadPlugins(config, program.directory)
  activity.end()

  // Multiple occurrences of the same name-version-pair can occur,
  // so we report an array of unique pairs
  const pluginsStr = _.uniq(flattenedPlugins.map(p => `${p.name}@${p.version}`))
  telemetry.decorateEvent(`BUILD_END`, {
    plugins: pluginsStr,
  })

  telemetry.decorateEvent(`DEVELOP_STOP`, {
    plugins: pluginsStr,
  })

  // onPreInit
  activity = reporter.activityTimer(`onPreInit`, {
    parentSpan,
  })
  activity.start()
  await apiRunnerNode(`onPreInit`, { parentSpan: activity.span })
  activity.end()

  // During builds, delete html and css files from the public directory as we don't want
  // deleted pages and styles from previous builds to stick around.
  if (
    !process.env.GATSBY_EXPERIMENTAL_PAGE_BUILD_ON_DATA_CHANGES &&
    process.env.NODE_ENV === `production`
  ) {
    activity = reporter.activityTimer(
      `delete html and css files from previous builds`,
      {
        parentSpan,
      }
    )
    activity.start()
    await del([
      `public/**/*.{html,css}`,
      `!public/page-data/**/*`,
      `!public/static`,
      `!public/static/**/*.{html,css}`,
    ])
    activity.end()
  }

  activity = reporter.activityTimer(`initialize cache`, {
    parentSpan,
  })
  activity.start()
  // Check if any plugins have been updated since our last run. If so
  // we delete the cache is there's likely been changes
  // since the previous run.
  //
  // We do this by creating a hash of all the version numbers of installed
  // plugins, the site's package.json, gatsby-config.js, and gatsby-node.js.
  // The last, gatsby-node.js, is important as many gatsby sites put important
  // logic in there e.g. generating slugs for custom pages.
  const pluginVersions = flattenedPlugins.map(p => p.version)
  const hashes: any = await Promise.all([
    !!process.env.GATSBY_EXPERIMENTAL_PAGE_BUILD_ON_DATA_CHANGES,
    md5File(`package.json`),
    md5File(`${program.directory}/gatsby-config.js`).catch(() => {}), // ignore as this file isn't required),
    md5File(`${program.directory}/gatsby-node.js`).catch(() => {}), // ignore as this file isn't required),
  ])
  const pluginsHash = crypto
    .createHash(`md5`)
    .update(JSON.stringify(pluginVersions.concat(hashes)))
    .digest(`hex`)
  const state = store.getState()
  const oldPluginsHash = state && state.status ? state.status.PLUGINS_HASH : ``

  // Check if anything has changed. If it has, delete the site's .cache
  // directory and tell reducers to empty themselves.
  //
  // Also if the hash isn't there, then delete things just in case something
  // is weird.
  if (oldPluginsHash && pluginsHash !== oldPluginsHash) {
    reporter.info(reporter.stripIndent`
      One or more of your plugins have changed since the last time you ran Gatsby. As
      a precaution, we're deleting your site's cache to ensure there's no stale data.
    `)
  }
  const cacheDirectory = `${program.directory}/.cache`
  const publicDirectory = `${program.directory}/public`

  // .cache directory exists in develop at this point
  // so checking for .cache/json as a heuristic (could be any expected file)
  const cacheIsCorrupt =
    fs.existsSync(`${cacheDirectory}/json`) && !fs.existsSync(publicDirectory)

  if (cacheIsCorrupt) {
    reporter.info(reporter.stripIndent`
      We've detected that the Gatsby cache is incomplete (the .cache directory exists
      but the public directory does not). As a precaution, we're deleting your site's
      cache to ensure there's no stale data.
    `)
  }

  if (!oldPluginsHash || pluginsHash !== oldPluginsHash || cacheIsCorrupt) {
    try {
      // Comment out inviet until we can test perf impact
      //
      // let sourceFileSystemVersion = flattenedPlugins.find(
      // plugin => plugin.name === `gatsby-source-filesystem`
      // )?.version

      // // The site might be using a plugin which uses "createRemoteFileNode" but
      // // doesn't have gatsby-source-filesystem in their gatsby-config.js. So lets
      // // also try requiring it.
      // if (!sourceFileSystemVersion) {
      // try {
      // sourceFileSystemVersion = require(`gatsby-source-filesystem/package.json`)
      // ?.version
      // } catch {
      // // ignore require errors
      // }
      // }
      // } else if (
      // sourceFileSystemVersion &&
      // semver.lt(sourceFileSystemVersion, `2.9.0`)
      // ) {
      // // If the site has more than 50 downloaded files in it, tell them
      // // how to save time.
      // try {
      // // Divide by two as the directory as both cache files + the actual downloaded files so
      // // two results / downloaded file.
      // const filesCount =
      // (await fs.readdir(`.cache/caches/gatsby-source-filesystem`))
      // .length / 2
      // if (filesCount > 50) {
      // reporter.info(stripIndent`\n\n

      // Your local development experience is about to get better, faster, and stronger!

      // Your friendly Gatsby maintainers detected your site downloads quite a few files and that we're about to delete all ${Math.round(
      // filesCount
      // )} of them 😅. We're working right now to make our caching smarter which means we won't delete your downloaded files any more.

      // If you're interested in trialing the new caching behavior *today* — which should make your local development environment faster, go ahead and enable the PRESERVE_FILE_DOWNLOAD_CACHE flag and run your develop server again.

      // To do so, add to your gatsby-config.js:

      // flags: {
      // preserve_file_download_cache: true,
      // }

      // visit the umbrella issue to learn more: https://github.com/gatsbyjs/gatsby/discussions/28331
      // `)
      // }
      // } catch {
      // // ignore errors (mostly will just be directory not found).
      // }
      // }

      if (
        process.env.GATSBY_EXPERIMENTAL_PRESERVE_FILE_DOWNLOAD_CACHE ||
        process.env.GATSBY_EXPERIMENTAL_PRESERVE_WEBPACK_CACHE
      ) {
        const deleteGlobs = [
          // By default delete all files & subdirectories
          `${cacheDirectory}/**`,
          `${cacheDirectory}/*/`,
        ]

        if (process.env.GATSBY_EXPERIMENTAL_PRESERVE_FILE_DOWNLOAD_CACHE) {
          // Add gatsby-source-filesystem
          deleteGlobs.push(`!${cacheDirectory}/caches/gatsby-source-filesystem`)
        }

        if (process.env.GATSBY_EXPERIMENTAL_PRESERVE_WEBPACK_CACHE) {
          // Add webpack
          deleteGlobs.push(`!${cacheDirectory}/webpack`)
        }
        await del(deleteGlobs)
      } else {
        // Attempt to empty dir if remove fails,
        // like when directory is mount point
        await fs.remove(cacheDirectory).catch(() => fs.emptyDir(cacheDirectory))
      }
    } catch (e) {
      reporter.error(`Failed to remove .cache files.`, e)
    }
    // Tell reducers to delete their data (the store will already have
    // been loaded from the file system cache).
    store.dispatch({
      type: `DELETE_CACHE`,
      cacheIsCorrupt,
    })

    // in future this should show which plugin's caches are purged
    // possibly should also have which plugins had caches
    telemetry.decorateEvent(`BUILD_END`, {
      pluginCachesPurged: [`*`],
    })
    telemetry.decorateEvent(`DEVELOP_STOP`, {
      pluginCachesPurged: [`*`],
    })
  }

  // Update the store with the new plugins hash.
  store.dispatch({
    type: `UPDATE_PLUGINS_HASH`,
    payload: pluginsHash,
  })

  // Now that we know the .cache directory is safe, initialize the cache
  // directory.
  await fs.ensureDir(cacheDirectory)

  // Ensure the public/static directory
  await fs.ensureDir(`${publicDirectory}/static`)

  activity.end()

  activity = reporter.activityTimer(`copy gatsby files`, {
    parentSpan,
  })
  activity.start()
  const srcDir = `${__dirname}/../../cache-dir`
  const siteDir = cacheDirectory
  const tryRequire = `${__dirname}/../utils/test-require-error.js`
  try {
    await fs.copy(srcDir, siteDir)
    await fs.copy(tryRequire, `${siteDir}/test-require-error.js`)
    await fs.ensureDirSync(`${cacheDirectory}/json`)

    // Ensure .cache/fragments exists and is empty. We want fragments to be
    // added on every run in response to data as fragments can only be added if
    // the data used to create the schema they're dependent on is available.
    await fs.emptyDir(`${cacheDirectory}/fragments`)
  } catch (err) {
    reporter.panic(`Unable to copy site files to .cache`, err)
  }

  // Find plugins which implement gatsby-browser and gatsby-ssr and write
  // out api-runners for them.
  const hasAPIFile = (env, plugin): string | undefined => {
    // The plugin loader has disabled SSR APIs for this plugin. Usually due to
    // multiple implementations of an API that can only be implemented once
    if (env === `ssr` && plugin.skipSSR === true) return undefined

    const envAPIs = plugin[`${env}APIs`]

    // Always include gatsby-browser.js files if they exist as they're
    // a handy place to include global styles and other global imports.
    try {
      if (env === `browser`) {
        return slash(
          require.resolve(path.join(plugin.resolve, `gatsby-${env}`))
        )
      }
    } catch (e) {
      // ignore
    }

    if (envAPIs && Array.isArray(envAPIs) && envAPIs.length > 0) {
      return slash(path.join(plugin.resolve, `gatsby-${env}`))
    }
    return undefined
  }

  const isResolved = (plugin): plugin is IPluginResolution => !!plugin.resolve

  const ssrPlugins: Array<IPluginResolution> = flattenedPlugins
    .map(plugin => {
      return {
        resolve: hasAPIFile(`ssr`, plugin),
        options: plugin.pluginOptions,
      }
    })
    .filter(isResolved)

  const browserPlugins: Array<IPluginResolution> = flattenedPlugins
    .map(plugin => {
      return {
        resolve: hasAPIFile(`browser`, plugin),
        options: plugin.pluginOptions,
      }
    })
    .filter(isResolved)

  const browserPluginsRequires = browserPlugins
    .map(plugin => {
      // we need a relative import path to keep contenthash the same if directory changes
      const relativePluginPath = path.relative(siteDir, plugin.resolve)
      return `{
      plugin: require('${slash(relativePluginPath)}'),
      options: ${JSON.stringify(plugin.options)},
    }`
    })
    .join(`,`)

  const browserAPIRunner = `module.exports = [${browserPluginsRequires}]\n`

  let sSRAPIRunner = ``

  try {
    sSRAPIRunner = fs.readFileSync(`${siteDir}/api-runner-ssr.js`, `utf-8`)
  } catch (err) {
    reporter.panic(`Failed to read ${siteDir}/api-runner-ssr.js`, err)
  }

  const ssrPluginsRequires = ssrPlugins
    .map(
      plugin =>
        `{
      plugin: require('${plugin.resolve}'),
      options: ${JSON.stringify(plugin.options)},
    }`
    )
    .join(`,`)
  sSRAPIRunner = `var plugins = [${ssrPluginsRequires}]\n${sSRAPIRunner}`

  fs.writeFileSync(
    `${siteDir}/api-runner-browser-plugins.js`,
    browserAPIRunner,
    `utf-8`
  )
  fs.writeFileSync(`${siteDir}/api-runner-ssr.js`, sSRAPIRunner, `utf-8`)

  activity.end()
  /**
   * Start the main bootstrap processes.
   */

  // onPreBootstrap
  activity = reporter.activityTimer(`onPreBootstrap`, {
    parentSpan,
  })
  activity.start()
  await apiRunnerNode(`onPreBootstrap`, {
    parentSpan: activity.span,
  })
  activity.end()

  // Collect resolvable extensions and attach to program.
  const extensions = [`.mjs`, `.js`, `.jsx`, `.wasm`, `.json`]
  // Change to this being an action and plugins implement `onPreBootstrap`
  // for adding extensions.
  const apiResults = await apiRunnerNode(`resolvableExtensions`, {
    traceId: `initial-resolvableExtensions`,
    parentSpan,
  })

  store.dispatch({
    type: `SET_PROGRAM_EXTENSIONS`,
    payload: _.flattenDeep([extensions, apiResults]),
  })

  const workerPool = WorkerPool.create()

  return {
    store,
    workerPool,
  }
}
