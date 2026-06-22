"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.logger = void 0;
const PREFIX = '[mongoose-cache]';
function noop(..._args) { }
exports.logger = {
    debug: noop,
    log(...args) {
        console.log(PREFIX, ...args);
    },
    warn(...args) {
        console.warn(PREFIX, ...args);
    },
    error(...args) {
        console.error(PREFIX, ...args);
    },
    count(_label) { },
    countReset(_label) { }
};
exports.default = exports.logger;
//# sourceMappingURL=logger.js.map