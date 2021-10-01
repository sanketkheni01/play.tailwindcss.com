import { klona } from 'klona/full'
import { VIRTUAL_SOURCE_PATH, VIRTUAL_HTML_FILENAME } from '../constants'
import extractClasses from './extractClasses'

const deps = {
  1: [
    () => import('tailwindcss-v1'),
    () => import('postcss-v7'),
    () => import('autoprefixer-postcss7'),
    () => import('tailwindcss-v1/lib/featureFlags'),
  ],
  2: [
    () => import('tailwindcss'),
    () => import('postcss'),
    () => import('autoprefixer'),
    () => import('tailwindcss/lib/featureFlags'),
    () => import('tailwindcss/resolveConfig'),
  ],
  3: [
    () => import('tailwindcss-v3'),
    () => import('postcss'),
    () => import('autoprefixer'),
    () => import('tailwindcss-v3/lib/featureFlags'),
    () => import('tailwindcss-v3/resolveConfig'),
  ],
}

const applyModule1 = require('tailwindcss-v1/lib/flagged/applyComplexClasses')
const applyModule2 = require('tailwindcss/lib/lib/substituteClassApplyAtRules')

const apply1 = applyModule1.default
const apply2 = applyModule2.default

export async function processCss(
  configInput,
  htmlInput,
  cssInput,
  tailwindVersion = '2',
  skipIntelliSense = false
) {
  let jit = false
  const config = klona(configInput)
  const [tailwindcss, postcss, autoprefixer, featureFlags, resolveConfig] = (
    await Promise.all(deps[tailwindVersion].map((x) => x()))
  ).map((x) => x.default || x)

  self[VIRTUAL_HTML_FILENAME] = htmlInput

  let separator =
    typeof config.separator === 'undefined' ? ':' : config.separator
  separator = `${separator}`

  if (
    (tailwindVersion === '2' && config.mode === 'jit') ||
    tailwindVersion === '3'
  ) {
    if (tailwindVersion === '3') {
      config.content = [VIRTUAL_HTML_FILENAME]
    } else {
      config.purge = [VIRTUAL_HTML_FILENAME]
    }
    jit = true
  } else {
    config.separator = `__TWSEP__${separator}__TWSEP__`
    config.purge = false
  }

  let jitContext
  if (jit && !skipIntelliSense) {
    jitContext = require('tailwindcss/lib/jit/lib/setupContextUtils').createContext(
      resolveConfig(config)
    )
  }

  const applyComplexClasses =
    tailwindVersion === '1' ? applyModule1 : applyModule2

  applyComplexClasses.default = (config, ...args) => {
    if (tailwindVersion === '3') {
      return require('tailwindcss-v3/lib/lib/expandApplyAtRules').default(
        jitContext
      )
    }

    if (jit) {
      return require('tailwindcss/lib/jit/lib/expandApplyAtRules').default(
        jitContext
      )
    }

    let configClone = klona(config)
    configClone.separator = separator

    let fn =
      tailwindVersion === '1'
        ? apply1(configClone, ...args)
        : apply2(configClone, ...args)

    return async (css) => {
      css.walkRules((rule) => {
        const newSelector = rule.selector.replace(
          /__TWSEP__(.*?)__TWSEP__/g,
          '$1'
        )
        if (newSelector !== rule.selector) {
          rule.before(
            postcss.comment({
              text: '__ORIGINAL_SELECTOR__:' + rule.selector,
            })
          )
          rule.selector = newSelector
        }
      })

      await fn(css)

      css.walkComments((comment) => {
        if (comment.text.startsWith('__ORIGINAL_SELECTOR__:')) {
          comment.next().selector = comment.text.replace(
            /^__ORIGINAL_SELECTOR__:/,
            ''
          )
          comment.remove()
        }
      })

      return css
    }
  }

  let css
  let lspRoot

  if (!jit) {
    let result = await postcss([tailwindcss(config), autoprefixer()]).process(
      cssInput,
      {
        from: undefined,
      }
    )
    css = result.css
    lspRoot = result.root
  } else {
    css = (
      await postcss([tailwindcss(config), autoprefixer()]).process(cssInput, {
        from: VIRTUAL_SOURCE_PATH,
      })
    ).css

    if (!skipIntelliSense && tailwindVersion !== '3') {
      lspRoot = (
        await postcss([
          tailwindcss({ ...config, mode: 'aot', purge: false, variants: [] }),
          autoprefixer(),
        ]).process(cssInput, {
          from: undefined,
        })
      ).root
    }
  }

  let state

  if (lspRoot || (tailwindVersion === '3' && !skipIntelliSense)) {
    state = {}
    state.jit = jit
    if (lspRoot) {
      state.classNames = await extractClasses(lspRoot)
    }
    state.separator = separator
    state.version =
      tailwindVersion === '1'
        ? require('tailwindcss-v1/package.json?version').version
        : tailwindVersion === '2'
        ? require('tailwindcss/package.json?version').version
        : require('tailwindcss-v3/package.json?version').version
    state.editor = {
      userLanguages: {},
      capabilities: {},
    }
    state.featureFlags = featureFlags
  }

  const escapedSeparator = separator.replace(/./g, (m) =>
    /[a-z0-9-_]/i.test(m) ? m : `\\${m}`
  )

  return {
    state,
    css: css.replace(/__TWSEP__.*?__TWSEP__/g, escapedSeparator),
    jit,
    ...(jit ? { html: htmlInput } : {}),
  }
}
