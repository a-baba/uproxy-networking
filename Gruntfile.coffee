TaskManager = require 'uproxy-lib/build/dist/build-tools/taskmanager'

#-------------------------------------------------------------------------
# The top level tasks. These are the highest level grunt-tasks defined in terms
# of specific grunt rules below and given to grunt.initConfig
taskManager = new TaskManager.Manager();

taskManager.add 'default', [ 'dev' ]

taskManager.add 'base-dev', [
  'copy:thirdParty'
  'copy:typescriptLibs'
  'copy:dev'
  'ts:devInModuleEnv'
  'ts:devInCoreEnv'
]

taskManager.add 'dev', [
  'base-dev'
]

Rules = require 'uproxy-lib/build/dist/build-tools/common-grunt-rules'
devBuildDir = 'build/dev'
Rule = new Rules.Rule({devBuildDir: devBuildDir});

path = require('path');
uproxyLibPath = path.dirname(require.resolve('uproxy-lib/package.json'))
ipaddrjsPath = path.dirname(require.resolve('ipaddr.js/package.json'))
# TODO(ldixon): update utransformers package to uproxy-obfuscators
# uproxyObfuscatorsPath = path.dirname(require.resolve('uproxy-obfuscators/package.json'))
uproxyObfuscatorsPath = path.dirname(require.resolve('utransformers/package.json'))
regex2dfaPath = path.dirname(require.resolve('regex2dfa/package.json'))
# Cordova testing
ccaPath = path.dirname(require.resolve('cca/package.json'))
pgpPath = path.dirname(require.resolve('freedom-pgp-e2e/package.json'))

#-------------------------------------------------------------------------
module.exports = (grunt) ->
  grunt.initConfig {
    pkg: grunt.file.readJSON 'package.json'

    copy:
      # Copy local |third_party| files into dev: so that the third_party
      # dependencies are always in the common |build/third_party| location. This
      # allows path to reference typescript definitions for ambient contexts to
      # always be found, even in generated `.d.ts` files..
      thirdParty:
        files: [
          {
              nonull: true,
              expand: true,
              src: ['third_party/**/*'],
              dest: 'build/',
              onlyIf: 'modified'
          }
        ]
      # Copy releveant non-typescript files to dev build.
      typescriptLibs:
        files: [
          # Copy distribution directory of uproxy-lib into the fixed build/dev
          # location, so all paths can always find their dependencies.
          {
              nonull: true,
              expand: true,
              cwd: path.join(uproxyLibPath, 'build/dist'),
              src: ['**/*'],
              dest: 'build/dev/',
              onlyIf: 'modified'
          },
          # Use the third_party definitions from uproxy-lib. Copied to the same
          # location relative to their compiled location in uproxy-lib so they
          # have the same relative path to the created `.d.ts` files from
          # |build/dev|.
          {
              nonull: true,
              expand: true,
              cwd: path.join(uproxyLibPath, 'build/third_party'),
              src: ['freedom-typings/**/*'],
              dest: 'build/third_party/',
              onlyIf: 'modified'
          },
          {
              nonull: true,
              expand: true,
              cwd: path.join(uproxyObfuscatorsPath, 'src/interfaces/'),
              src: ['**/*'],
              dest: 'build/third_party/uproxy-obfuscators',
              onlyIf: 'modified'
          }
        ]
      # Copy releveant non-typescript files to dev build.
      dev:
        files: [
          {
              nonull: true,
              expand: true,
              cwd: 'src/',
              src: ['**/*', '!**/*.ts'],
              dest: devBuildDir,
              onlyIf: 'modified'
          }
        ]
      # Copy releveant non-typescript files to distribution build.
      dist:
        files: [
          {
              nonull: true,
              expand: true,
              cwd: devBuildDir,
              src: ['**/*',
                    '!**/*.spec.js',
                    '!**/*.spec.*.js'],
              dest: 'build/dist/',
              onlyIf: 'modified'
          }
        ]

      # Copy the freedom output file to sample apps
      freedomLibsFor:
        Rule.copyFreedomLibs 'freedom', ['loggingprovider'],
          'samples/simple-freedom-chat'
      freedomLibsFor:
        Rule.copyFreedomLibs 'freedom', ['loggingprovider'],
          'samples/copypaste-freedom-chat/'

    # Typescript compilation rules
    ts:
      # Compile all non-sample typescript code into the development build
      # directory.
      devInModuleEnv:
        src: [
          'src/**/*.ts',
          '!src/**/*.core-env.ts',
          '!src/**/*.core-env.spec.ts',
        ]
        outDir: 'build/dev/'
        baseDir: 'src'
        options:
          target: 'es5'
          comments: true
          noImplicitAny: true
          sourceMap: false
          declaration: true
          module: 'commonjs'
          fast: 'always'

      devInCoreEnv:
        src: [
          'src/**/*.core-env.spec.ts',
          'src/**/*.core-env.ts',
        ]
        outDir: 'build/dev/'
        baseDir: 'src'
        options:
          target: 'es5'
          comments: true
          noImplicitAny: true
          sourceMap: false
          declaration: true
          module: 'commonjs'
          fast: 'always'


    jasmine:
      arraybuffers: Rule.jasmineSpec 'arraybuffers'
      buildTools: Rule.jasmineSpec 'build-tools'
      handler: Rule.jasmineSpec 'handler'
      logging: Rule.jasmineSpec 'logging'
      loggingProvider: Rule.jasmineSpec 'loggingprovider'
      webrtc: Rule.jasmineSpec 'webrtc'

    browserify:
      # Browserify freedom-modules in the library
      churnPipe: Rule.browserify 'churn-pipe/freedom-module'
      echo: Rule.browserify 'echo/freedom-module'
      # Browserify specs
      arraybuffersSpec: Rule.browserifySpec 'arraybuffers/arraybuffers'
      buildToolsTaskmanagerSpec: Rule.browserifySpec 'build-tools/taskmanager'
      handlerSpec: Rule.browserifySpec 'handler/queue'
      loggingProviderSpec: Rule.browserifySpec 'loggingprovider/loggingprovider'
      loggingSpec: Rule.browserifySpec 'logging/logging'
      webrtcSpec: Rule.browserifySpec 'webrtc/peerconnection'
      # Browserify sample apps main freedom module and core environments
      copypasteFreedomChatMain: Rule.browserify 'samples/copypaste-freedom-chat/main.core-env'
      copypasteFreedomChatFreedomModule: Rule.browserify 'samples/copypaste-freedom-chat/freedom-module'
      simpleFreedomChatMain: Rule.browserify 'samples/simple-freedom-chat/main.core-env'
      simpleFreedomChatFreedomModule: Rule.browserify 'samples/simple-freedom-chat/freedom-module'

    clean:
      build:
        [ 'build/dev', 'build/dist'
          # Note: 'src/.baseDir.ts' and '.tscache/' are created by grunt-ts.
          '.tscache/'
          'src/.baseDir.ts' ]
  }  # grunt.initConfig

  #-------------------------------------------------------------------------
  grunt.loadNpmTasks 'grunt-browserify'
  grunt.loadNpmTasks 'grunt-contrib-clean'
  grunt.loadNpmTasks 'grunt-contrib-copy'
  grunt.loadNpmTasks 'grunt-contrib-jasmine'
  grunt.loadNpmTasks 'grunt-jasmine-chromeapp'
  grunt.loadNpmTasks 'grunt-ts'

  #-------------------------------------------------------------------------
  # Register the tasks
  taskManager.list().forEach((taskName) =>
    grunt.registerTask taskName, (taskManager.get taskName)
  );
