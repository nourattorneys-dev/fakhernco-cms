"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const config = {
    rest: {
        defaultLimit: 25,
        maxLimit: 100,
        withCount: true,
        strictParams: true,
    },
    documents: {
        strictParams: true,
        strictRelations: true,
    },
};
exports.default = config;
