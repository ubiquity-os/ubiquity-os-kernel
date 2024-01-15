const fs = require("fs");
const path = require("path");
const Ajv = require("ajv");
const standaloneCode = require("ajv/dist/standalone").default;
const SCHEMA = require("@octokit/webhooks-schemas");
const addFormats = require("ajv-formats");

const ajv = new Ajv({ code: { source: true, esm: true } });
addFormats(ajv);
ajv.addKeyword("tsAdditionalProperties");
const validate = ajv.compile(SCHEMA);
let moduleCode = standaloneCode(ajv, validate);

// Now you can write the module code to file
fs.writeFileSync(path.join(__dirname, "./src/github-event-validator.mjs"), moduleCode);
