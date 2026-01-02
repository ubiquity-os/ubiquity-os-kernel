module.exports = {
  "*.ts": ["deno run -A npm:prettier@3.3.3 --write", "deno run -A npm:eslint@9.7.0 --fix --cache --cache-location .cache/eslint/.eslintcache"],
  "src/**.*": ["deno run -A npm:cspell@8.9.0"],
};
