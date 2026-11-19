import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildWeb } from "./build-web-lib.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
buildWeb(root);
console.log("web bundle written to web/bundle.js and web/bundle.css");
