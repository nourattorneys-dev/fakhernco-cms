"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const path_1 = __importDefault(require("path"));
const database_1 = require("@strapi/database");
const config = ({ env }) => {
    const client = env('DATABASE_CLIENT', 'sqlite');
    if (!(0, database_1.isDatabaseClientKind)(client)) {
        throw new Error(`Unsupported DATABASE_CLIENT: ${client}. Use "postgres", "mysql", or "sqlite".`);
    }
    const connections = {
        mysql: {
            client: 'mysql',
            connection: {
                host: env('DATABASE_HOST', 'localhost'),
                port: env.int('DATABASE_PORT', 3306),
                database: env('DATABASE_NAME', 'strapi'),
                user: env('DATABASE_USERNAME', 'strapi'),
                password: env('DATABASE_PASSWORD', 'strapi'),
                /**
                 * utf8mb4, always.
                 *
                 * MySQL's legacy `utf8` is three bytes and silently mangles curly
                 * quotes, en/em dashes, the euro sign and anything outside the BMP.
                 * This site is bilingual English/Arabic, so the wrong charset here
                 * corrupts half the content on import and reports no error.
                 *
                 * This governs the CONNECTION. The database itself must also be
                 * created correctly, or the default collation still wins:
                 *   CREATE DATABASE x CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
                 */
                charset: env('DATABASE_CHARSET', 'utf8mb4'),
                ssl: env.bool('DATABASE_SSL', false) && {
                    key: env('DATABASE_SSL_KEY', undefined),
                    cert: env('DATABASE_SSL_CERT', undefined),
                    ca: env('DATABASE_SSL_CA', undefined),
                    capath: env('DATABASE_SSL_CAPATH', undefined),
                    cipher: env('DATABASE_SSL_CIPHER', undefined),
                    rejectUnauthorized: env.bool('DATABASE_SSL_REJECT_UNAUTHORIZED', true),
                },
            },
            pool: { min: env.int('DATABASE_POOL_MIN', 2), max: env.int('DATABASE_POOL_MAX', 10) },
        },
        postgres: {
            client: 'postgres',
            connection: {
                connectionString: env('DATABASE_URL'),
                host: env('DATABASE_HOST', 'localhost'),
                port: env.int('DATABASE_PORT', 5432),
                database: env('DATABASE_NAME', 'strapi'),
                user: env('DATABASE_USERNAME', 'strapi'),
                password: env('DATABASE_PASSWORD', 'strapi'),
                ssl: env.bool('DATABASE_SSL', false) && {
                    key: env('DATABASE_SSL_KEY', undefined),
                    cert: env('DATABASE_SSL_CERT', undefined),
                    ca: env('DATABASE_SSL_CA', undefined),
                    capath: env('DATABASE_SSL_CAPATH', undefined),
                    cipher: env('DATABASE_SSL_CIPHER', undefined),
                    rejectUnauthorized: env.bool('DATABASE_SSL_REJECT_UNAUTHORIZED', true),
                },
                schema: env('DATABASE_SCHEMA', 'public'),
            },
            pool: { min: env.int('DATABASE_POOL_MIN', 2), max: env.int('DATABASE_POOL_MAX', 10) },
        },
        sqlite: {
            client: 'sqlite',
            connection: {
                // Resolve from the project root. path.join does not reset on absolute
                // segments, so an absolute DATABASE_FILENAME would otherwise end up
                // nested underneath the project directory.
                filename: (() => {
                    const f = env('DATABASE_FILENAME', '.tmp/data.db');
                    return path_1.default.isAbsolute(f) ? f : path_1.default.join(process.cwd(), f);
                })(),
            },
            useNullAsDefault: true,
        },
    };
    return {
        connection: {
            ...connections[client],
            acquireConnectionTimeout: env.int('DATABASE_CONNECTION_TIMEOUT', 60000),
        },
    };
};
exports.default = config;
