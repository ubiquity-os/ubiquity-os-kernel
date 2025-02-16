# Changelog

## [2.1.5](https://github.com/ubiquity-os/ubiquity-os-kernel/compare/v2.1.4...v2.1.5) (2024-10-11)

### Bug Fixes

- update token variable and reorder dependencies ([f3c5df8](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/f3c5df8b57e135c0e367c40cec19f8fea102bc28))

## [2.1.4](https://github.com/ubiquity-os/ubiquity-os-kernel/compare/v2.1.3...v2.1.4) (2024-10-11)

### Bug Fixes

- update package name in package.json ([a8ac6fb](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/a8ac6fbdab86622dd40ed5382f79babd15f13565))

## [2.1.3](https://github.com/ubiquity-os/ubiquity-os-kernel/compare/v2.1.2...v2.1.3) (2024-10-11)

### Bug Fixes

- add npm token authentication ([d551da3](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/d551da3f55f4f1e09b731a47428f70ee42417cb0))

## [2.1.2](https://github.com/ubiquity-os/ubiquity-os-kernel/compare/v2.1.1...v2.1.2) (2024-10-11)

### Bug Fixes

- update eslint ignores ([758145b](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/758145bf998e66560ae105e0353b8a5ede05f19f))
- update Husky setup for production and CI ([9a76d37](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/9a76d37ec6839f2296cece682192b9cb653b0553))
- update husky to version 9.1.6 ([ca08e9f](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/ca08e9f8485a9ae8129e96fdefe052c1a9109ac0))

## [2.1.1](https://github.com/ubiquity-os/ubiquity-os-kernel/compare/v2.1.0...v2.1.1) (2024-10-11)

### Bug Fixes

- update release-please.yml ([4fb79a0](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/4fb79a0c736d5e23701084bd5d4fcd66b7e41f19))

## [2.1.0](https://github.com/ubiquity-os/ubiquity-os-kernel/compare/v2.0.0...v2.1.0) (2024-10-11)

### Features

- development config ([94e2685](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/94e26850def80bfd770149bc364967745c58b7a0))
- enabling worker observability ([4853aa8](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/4853aa80b824274c3fdfae1f0380ab121ba6e847))

### Bug Fixes

- install @ubiquity-os/ubiquity-os-logger ([4d6eae9](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/4d6eae95d0826a20c8f52ac9c991bc85eeb4c379))
- remove broken test ([472e929](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/472e929324319ee7d7282cb8fc960d63445ec737))
- update release workflow for node support ([5e1239e](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/5e1239e7622eaa9af8fbfe3a9ae925cd8cce0d70))

## [2.0.0](https://github.com/ubiquity-os/ubiquity-os-kernel/compare/v1.0.0...v2.0.0) (2024-09-25)

### ⚠ BREAKING CHANGES

- renamed kernel toml

### Features

- actions sdk ([c4160c6](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/c4160c6d095a0354f59666c5f8e90cfceaab1a4c))
- add app id and bot user id ([d292f5a](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/d292f5abf93301aaee0d508a0166d891ac36fd18))
- add tests ([2be91f6](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/2be91f648bb2c98e73549e5a7ed7fd5c5025098d))
- added branch deployment ([51f1276](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/51f1276aac4a4c382876a83e597d4610bcbbb65b))
- added ref on manifest.json retrieval for workers ([bd1f58f](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/bd1f58fac4fc2e591411e3696baab22cb0b247e1))
- added tests for ref manifest fetching ([49bef29](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/49bef29e119de767a55edd4d6069417f4984e977))
- test for skipBotEvents ([128e93e](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/128e93efc9a28533834d009d582f62894a2a4927))

### Bug Fixes

- log if comment can't be created ([ba98cb6](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/ba98cb691e168b5d563ac45611cd10cc08216f93))
- manifest commands are properly checked for skipping ([b4e8fb6](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/b4e8fb6642dd3a759583c1998b1a351b4f3f0e56))
- regex to match action now accepts higher depth ([668062f](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/668062fcee5d3aab60cc97ac7434f57b4efcbb35))
- tests ([e32602a](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/e32602a1f357d093a2a7471796fbe54ae49176e5))
- trimming body to find commands ([fd17b58](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/fd17b5814da8ca35812738a7a3bf06ab8bee18dd))

### Miscellaneous Chores

- renamed kernel toml ([1c42c47](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/1c42c47fd1f8916d71b90cd5cbff846e029e16ef))

## 1.0.0 (2024-08-14)

### ⚠ BREAKING CHANGES

- renamed PRIVATE_KEY to APP_PRIVATE_KEY, APP_WEBHOOK_SECRET optional and removed WEBHOOK_PROXY_URL
- bumped eslint to v9
- removed GitHub type from the configuration as it is deduced using the plugin element string

### Features

- add conventional commits ([9c9366a](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/9c9366ad423cfb450909c36f735aa08c222cd319))
- add dotenv ([7b7c6f5](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/7b7c6f5decd076cf833352c03906e2dcb514428f))
- add hello-world plugin example ([957f0bb](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/957f0bb313c5c5b8f4376fc9b09d4a71b65cbcc5))
- add knip CI configuration ([83b6cb6](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/83b6cb68ce08cd279b315718586ad8f136e065ba))
- add naming conventions rule ([f3997c9](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/f3997c9b635dc8d027965b65079423bbba268986))
- add pull request template ([e7fff97](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/e7fff971d1ef38f2fc18516c5ba45322490a4a8c))
- add tests for defaults ([b7bd2f9](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/b7bd2f94cf82e42b50411346b8687875f9105177))
- add TS support ([f9b45ea](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/f9b45eaae8f7e2da76cd9979fd60217f4d4938cc))
- add webhook events list ([d504575](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/d504575fa527fbd2a5a46b0b0001920ca9b50023))
- added bot default configuration ([edc33a2](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/edc33a25dbed44768c7a9b76799dd0004c9aa374))
- added instructions to deploy to Cloudflare Workers ([54c29c8](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/54c29c85a0468ac285bbbfeef012b64dd564f3bd))
- added manifest to hello-world-plugin.ts ([d93b5c3](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/d93b5c33ca0913a09a78034c7de7100f232a46c6))
- added release-please.yml ([1ee4961](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/1ee4961c3b05ed9b8b69520cc18aef9d6d54c73d))
- ban non null assertions ([e674345](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/e6743454269235a4d1b632742fd723287e16a190))
- bumped eslint to v9 ([21d800a](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/21d800a649d709477a8ef7b49477886bb431523c))
- cd ([9fbac16](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/9fbac16e59476e56333baa5c7e89fb177ed40313))
- commit or pr ([dbec9e3](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/dbec9e30f1bbfb9a6514cb68c0507db37dd7cf2b))
- config event handler ([89f7de7](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/89f7de7317865d223ea28c6f5779c65f69c79eb5))
- configuration is fetched org wide ([f42928d](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/f42928de3cea24b187e686cbd79f71253b36bcb8))
- configuration is fetched org wide ([91eb0be](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/91eb0be52a9d5cdefbe92eede3c1eebf8dacf84e))
- copy typescript rules ([86cb568](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/86cb56883e02419c919c7646d62fea530a5ff99f))
- create helloWorld index.html ([d1e8b0b](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/d1e8b0b52130f6cc206675b7e2b8b616da2fda81))
- **cspell:** support colors ([27786d7](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/27786d7d0ba92c4268395ab38675627bc9bef8ea))
- cypress testing suite ([92cad2c](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/92cad2c46aabc81b42a926298270adbd38adffdc))
- default Jest testing configuration ([d7670f4](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/d7670f4d4b7ba307052117a9928540b9d967ec13))
- default Jest testing configuration ([#19](https://github.com/ubiquity-os/ubiquity-os-kernel/issues/19)) ([f0c06fb](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/f0c06fba5fdcc6919d009f17197b303916608530))
- easy ui support ([7ffbda1](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/7ffbda1732fbb579cb0f9db0e8e59a8521b02725))
- easy ui support ([805224f](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/805224f0a3c2fb13205e0d0fe184844e99fab02d))
- event handler ([1056cac](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/1056cacce712afe8bcad2316185c67b33c4a3a8d))
- export ([f56714b](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/f56714b24474400f82e1e53026d4cfd600549091))
- export context ([1f6c922](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/1f6c922956113f9d9d131237fcd3afe19f53ff33))
- fix tests ([2b150a1](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/2b150a108e7e69c0832cf87dd107421032cbb97d))
- format on lint-staged ([bfcfcda](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/bfcfcdaab8c0aed6fda112e579d9f4f4bb557ee0))
- github event validation ([a7f95a0](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/a7f95a06e4ec5e829123be1cca326b0bb5d712a7))
- help is displayed on /help command ([7033aac](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/7033aacf6d072cbdf133d59ad61610e1ed67cd25))
- initial commit ([080bedf](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/080bedf1c104dd8ace4495edd595fbcee3c22ab9))
- jest testings ([8605a37](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/8605a375d9036819276312a3afbc7c3e1a08fe91))
- jest typescript config ([132537c](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/132537c6849ede075c25dd81d39b7c12f76101c1))
- kill port 8787 before starting dev ([7d77f6f](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/7d77f6fb10e56e340c29c56f93dd8103871b592f))
- manifest is now read and cached from the target repo ([9c66d70](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/9c66d7077cf64b6609b6d3abdaba1686b8dba775))
- manifest is now read and cached from the target repo ([76af3a0](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/76af3a0b4efa380b0d495c2532a308123902d074))
- miniflare ([ccdfceb](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/ccdfcebc412a90b23ee92a082bfdf7b2abbdbcda))
- multiple commands can be handled for skip ([7b3e111](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/7b3e11100ce055961309c1faed38f10cf14f82f6))
- mvp logs events ([0ba9c2b](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/0ba9c2bdacd968398dc2003be4ff90bb8506638a))
- new github env style ([6eb4ace](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/6eb4ace9aff0ce51d1b09befa1b85e09c6eca81f))
- octokit ([9e70be5](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/9e70be557b627c8bef981e728111ad8f88c02428))
- pass auth token instead of installation id ([b224246](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/b224246f1fba464118d7e5b825fd174bd5564c00))
- plugin chain config and repo dispatch handler ([7bd5ff8](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/7bd5ff8c081887dc372c74d62739a3345ed257b4))
- plugin for issue closed ([36e1a03](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/36e1a033326955a6924d61a8a7a9f67485bedec0))
- prefer named functions ([31825e8](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/31825e82fc48c0e4b8480598f291ce8b1bc88d1a))
- private key format ([fdd7c4a](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/fdd7c4a623dabf6664f799a1d394203be1c420cf))
- production deploys ([821f81e](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/821f81e95925b9dcfc8ae6631bae3150b1cfcb27))
- push action for development branch ([af60573](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/af605734b9a66fa4b1d5b5887704e2940de43cf6))
- ref ([b02d104](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/b02d1049d5eb7c175fdbec981d0b19ab312bc188))
- remove ajv validation ([bdd173d](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/bdd173d7458b1102754b7db8f210f3ccba0df994))
- remove configuration package ([091a395](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/091a395b87405fd6160023548754048b9f188d05))
- remove our enum because we use octokit's types ([3c0b829](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/3c0b829cd98be122ae4270347eaaead73cecec4a))
- replace expressions in nested objects ([daaaf9a](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/daaaf9a898d4af990fe81475dccbb2cb0a1b6b69))
- reusable deploy script ([4e8bf2b](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/4e8bf2b14aa38ad0e3bcdd82a4e080be86d77179))
- sdk ([b42f9b6](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/b42f9b6c7fff1a37a840c686311229251dda5154))
- serve manifest ([34adce1](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/34adce187ac254db3b3cb2dfb52f044c7809c19b))
- sign function ([aab2c8c](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/aab2c8cbb657ca0a998977641610408242fc3163))
- signature in payload ([6cfd934](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/6cfd9348c4df56e2e4c483b03f73d8e09697695d))
- skip bot events ([37cb25c](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/37cb25cd537ec795d2a3fb7940cf19a8afcc8991))
- skip commands that don't match ([71f995f](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/71f995f0a0036ec6315925b2c6572177e4c8471a))
- spell check on commit ([53bfa02](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/53bfa0258251b2e775699bfc6a5120f174ccaf58))
- store event payload, inputs and outputs of plugins in chain state ([d769841](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/d76984151b5073ec8e93be4d346e87ff4a853e6e))
- support using output from previous plugins ([0d83199](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/0d831998fcbfd48b4add7a85776e906091aac879))
- type check on ci ([7ecf406](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/7ecf406d6ca7ec344ba9d3956ce5ee736b23c1a8))
- ubiquity-os-logger integration ([0585355](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/0585355b3b80090d124cfd98dab9f5f72298773a)), closes [#5](https://github.com/ubiquity-os/ubiquity-os-kernel/issues/5)
- ubiquity logger ([4053df7](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/4053df7252759b74359bf05fdc87fd1d92be0875))
- update instructions ([92e48bf](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/92e48bf6e6e651f5e959b235ee57d22a1877de65))
- update packages ([16a346a](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/16a346ab634c45798cebafe9f2e71101350593b3))
- update readme ([d2cb9f8](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/d2cb9f89841650c76596a03d0eab4a3026244247))
- updated delegated compute inputs ([0979fd7](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/0979fd7bef16b87f1a30af1fc75f5d947afaef2c))
- webhook type ([084d1c1](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/084d1c19d13761d519fa7292122545991c9fef39))
- workflow dispatch ([126e819](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/126e819301653d30eede0849d258e44db973f2ba))
- workflow dispatch ([dc336a9](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/dc336a9d2902a4c425491ac61fbc5325ad6e4826))
- workflow dispatch ([b17af14](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/b17af14452281e2410fd64b4ded34f8d196b7d8e))
- working POC ([e379d71](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/e379d71f52692105438cd3e187f4b645628e0076))

### Bug Fixes

- add env param ([b5fd06d](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/b5fd06d99b3ce97a37aab7cb83d3a663f77294b7))
- add missing events ([10887c3](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/10887c3c00a796774083ab71e82d36dd9ba5be42))
- added MD escape for content ([05c505c](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/05c505ceac36c206b0c25145dc123595940fb9a2))
- added tests related to help command ([bfa8fe8](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/bfa8fe865158478923d8d1624f1cd565ea3ab410))
- app installation if ([059487c](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/059487c910fbf671ef99a058631af40ed83ed12c))
- bug with default ([95b1bcb](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/95b1bcbf999353655963708983044783fe50531b))
- **cd:** deploy ([a3df7a7](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/a3df7a7b61ec4c2c4bd9f7265aea6928fa0a5e3f))
- **cd:** deploy ([b7b86c3](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/b7b86c34fc7d4cc44e3e321f070e214f36722fca))
- **cd:** deploy ([ee5e8a5](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/ee5e8a51dfaa2169401dccd6422458f59e8713ce))
- change dist to static ([783e786](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/783e786dfce63e702672f5a09f58935fad75b1ae))
- change file name ([561077e](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/561077e5713a202bfff476948d46ac2d3e1556be))
- ci ([026ed42](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/026ed429e5ea1ca164d46a138042cb26e8f3b259))
- ci test ([199c646](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/199c646085e13c93ea101581f6de5d157e759f60))
- **ci:** cspell ([ea8c924](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/ea8c924d95ef36ef5ece2ac3a5b6e0153c6b816a))
- **ci:** cspell ([48b4419](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/48b441995dbc0a78b5de5bb2dd353fa77ef804ae))
- **ci:** install bun ([37254d0](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/37254d01b9b3e0604ed054d6fe98dffab7e3a7f6))
- **ci:** on prs ([f2fea11](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/f2fea11b632888bd7f7eebb310905843d6c57f70))
- **ci:** use bun ([2296583](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/229658330aeeac61cc8c8c2a0becff5cab53f16c))
- cleaner approach via whilefoo ([7bf804c](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/7bf804cd5b5fa64c2c809bcf6ab0b368da25e8af))
- cloudflare doesn't seem to support console.trace ([b39aa1f](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/b39aa1f3a0c8810791a41136044d45d7fcc09513))
- commit sha ([2393807](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/23938078cf1e720c714698d6b966dff395153c61))
- commit-msg script and add lint-staged command ([7c2aa64](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/7c2aa64df980c4937812c09d4038b19de7ea8cda))
- cspell ([ddedba0](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/ddedba0b073067fc4443dd23815b7cccd7cbc79f))
- cspell ci ([8ee208a](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/8ee208a1dd30d5c708a61e636cca29b04b373aac))
- define entrypoint in wrangler.toml ([6cbd708](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/6cbd708c1d5da04328491f0eb6769431f1e26cd3))
- disabled comments on every push, and added default value for coverage ([419442c](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/419442c644651ec8db72e26f446b56123b284ebf))
- enabled nodejs compat ([bc05c58](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/bc05c5815161dfc78a825ef9367d55c56ce6e30c))
- enabled nodejs compat ([8b27baa](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/8b27baa661b8162de23378ac2e9f684282dfff93))
- enabled nodejs compat ([41e4b96](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/41e4b96a62555a0c83d033e9541fe4c5eb91615e))
- escape only pipes ([6e24973](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/6e2497385c688c8b459cbd3032a84df77e2941bd))
- file name ([98fdee7](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/98fdee7f84ec3ec4aa57ebdd990cf2172a694bb5))
- forgot to include cspell ([4026845](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/4026845606011433d71c78a921ebf1f93d5d83e8))
- generic typo ([99559ff](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/99559ff7a1e4b228f978e4266b5a6898c5eeeacb))
- gitignore ([4818b15](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/4818b15f6f0b3cdfe74a96fd8fa94c0f6ed6461c))
- import buffer from node namespace ([bd9c210](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/bd9c21053c4131121150a1fd1277d4e9fc57307e))
- knip, test ([6018c59](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/6018c596cea743d0e41457434fbda4a40df59ff2))
- lint errors ([40a20da](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/40a20daddc0806762faa5c6025c8fae9b138223b))
- lint staged ([9cad989](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/9cad989afff96c8786db86cb92df64e808b5f405))
- lint staged ([937630e](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/937630eb4abf93b7f3055b660e9bebc809d53399))
- merge now happens on plugins keys ([f548451](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/f548451c184de6b5684a7911eb7c14835beaeaae))
- move env to types, update packages, remove unused functions ([06fc88c](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/06fc88c19cddcf5a75f1ee5b26b58645900e53be))
- packages ([7277580](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/7277580ae867ec22c01e73317d3ec4cffbfce325))
- pin version ([4cd4ae6](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/4cd4ae6edf7aed0d8ffa13a93459ea0136794156))
- prettier for css ([4880237](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/4880237fb5d524e8315638f10bae984f3942999c))
- refactor into smaller functions ([387d33b](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/387d33b225407efbea20302536b93f920b794e60))
- remove commented code ([f78352e](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/f78352ebc9fbff2927ed143216be83dec245a5fc))
- remove test ([44d49d7](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/44d49d7474b3f1eaa27d3177e2a74fd4d3ff4c10))
- remove toString() ([295284a](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/295284a3b608bc0edde0acf9c85bb3f4f54de3fd))
- remove ubiquity-os phrasing ([b22d978](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/b22d97842415be571c1b210a61cf5b9dd0aea913))
- remove unused import ([c96e2a7](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/c96e2a707743616df666d27974bacd99a4abe5ba))
- removed GitHub type from the configuration as it is deduced using the plugin element string ([570b68e](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/570b68e18639e9c38a90872cfb8cbfbbdf661481))
- rename pull_request_template ([8aa986e](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/8aa986e6885173d56f628ee6d887d3619a19407c))
- renamed PRIVATE_KEY to APP_PRIVATE_KEY, APP_WEBHOOK_SECRET optional and removed WEBHOOK_PROXY_URL ([f71043e](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/f71043e7f1fe0277591e0682e2ff3340e206e0b9))
- resolve conflicts ([403232c](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/403232cdc4aee6260bf968875d90edf211a6c961))
- return default conf on custom conf fail ([207f68e](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/207f68e5e8ff2c018173636035cdf8bc3316f0c6))
- spell ([b40750f](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/b40750ffa37ec668eb1dd0c2ee7fd0525c66f73f))
- tests ([7d6d1c0](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/7d6d1c0b18ca5f2067e3b6737e22c30e03378a73))
- transport secrets ([83c2e29](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/83c2e2948ccce120400f943334a2c3bdb573f175))
- tsup ([e0ccba3](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/e0ccba36bc84febb11e00146aa2ea1c051e6fe0d))
- type error i introduced ([de6b510](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/de6b510bd412645a595722dd893abd750f7f784f))
- types ([bfe4651](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/bfe46515a257ff6c41b97581d25f4c125046f60f))
- typescript too complex expression ([597d9ce](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/597d9cea431527148496fa0e09ba2cce4bca2368))
- union too complex solve ([39cd3e8](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/39cd3e84b6ffe0b86bd79a65cec5262035294ddc))
- whitespace ([1f80af6](https://github.com/ubiquity-os/ubiquity-os-kernel/commit/1f80af63af8b2c1d97b125fd64b0a248e8d4ded0))
