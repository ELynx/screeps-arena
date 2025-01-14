'use strict'

import clear from 'rollup-plugin-clear'
import resolve from '@rollup/plugin-node-resolve'
import commonjs from '@rollup/plugin-commonjs'
import typescript from 'rollup-plugin-typescript2'
import copy from 'rollup-plugin-copy'

import fg from 'fast-glob'

let targetArena = ''

if (process.argv[3] === '--config-') {
  // we running dynamic mode
  targetArena = process.argv[4] || ''
} else if (process.argv[3] === '--environment') {
  targetArena = process.env.DEST
}

function getOptions (arenaSrc) {
  const outDir = arenaSrc.replace('src/', 'dist/')

  const options = {
    input: `${arenaSrc}/main.ts`,
    external: ['game', 'game/prototypes', 'game/constants', 'game/utils', 'game/path-finder', 'arena', 'game/visual'], // <-- suppresses the warning
    output: {
      dir: outDir,
      format: 'esm',
      entryFileNames: '[name].mjs',
      sourcemap: false,
      preserveModules: true,
      preserveModulesRoot: arenaSrc,
      paths: path => {
        // https://rollupjs.org/guide/en/#outputpaths
        // TS requires that we use non-relative paths for these "ambient" modules
        // The game requires relative paths, so prefix all game modules with "/" in the output bundle
        if (path.startsWith('game') || path.startsWith('arena')) {
          return '/' + path
        }
      }
    },

    plugins: [
      clear({ targets: targetArena === '' ? ['dist'] : [outDir] }), // If targeted build, only clear target sub-directory
      resolve({ rootDir: 'src' }),
      commonjs(),
      typescript({ tsconfig: './tsconfig.json' }),
      copy({
        targets: [
          { src: arenaSrc + '/jsconfig.json', dest: outDir },
          { src: arenaSrc + '/typings', dest: outDir }
        ]
      })
    ]
  }

  return options
}

let arenas = fg.sync(`src/*${targetArena}*`, { onlyDirectories: true })
arenas = arenas.filter(x => x.split('/').length === 2) // only one level below

if (arenas.length === 0) {
  throw new Error('No matching arenas found in src/. Exiting')
} else {
  console.log('Building arenas')

  for (const arena of arenas) {
    console.log(arena)
  }
}

export default arenas.map(getOptions)
