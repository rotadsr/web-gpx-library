// Runs tests/cases.js under Node using jsdom (not a project dependency):
//   NODE_PATH=/path/to/node_modules node tests/run-node.js
const fs = require('fs'), path = require('path'), vm = require('vm');
const { JSDOM } = require('jsdom');
const root = path.join(__dirname, '..');
const dom = new JSDOM('');
let failed = 0;
const ctx = { DOMParser: dom.window.DOMParser, XMLSerializer: dom.window.XMLSerializer, console };
ctx.assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
ctx.assertEq = (a, b, m) => { if (a !== b) throw new Error((m || 'not equal') + ': ' + JSON.stringify(a) + ' !== ' + JSON.stringify(b)); };
ctx.test = (name, fn) => {
  try { fn(); console.log('PASS ', name); } catch (e) { failed++; console.log('FAIL ', name, '\n     ', e.message); }
};
vm.createContext(ctx);
const load = f => vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), ctx, { filename: f });
// `const` globals in vm scripts aren't properties of ctx, so re-export them explicitly
vm.runInContext(fs.readFileSync(path.join(root, 'js/util.js'), 'utf8') + '\n' +
                fs.readFileSync(path.join(root, 'js/gpxParser.js'), 'utf8') + '\n' +
                fs.readFileSync(path.join(root, 'js/gpxEdit.js'), 'utf8') + '\n' +
                fs.readFileSync(path.join(__dirname, 'cases.js'), 'utf8'), ctx, { filename: 'tests' });
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
