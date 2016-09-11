'use strict';

const path = require('path');
const koaRouter = require('koa-router');
const Joi = require('joi');
const validateNpmPackageName = require('validate-npm-package-name');
const get = require('lodash/get');
const badgeVault = require('./util/badgeVault');

function validateJoiSchema(schema, input) {
    const validation = schema.validate(input);

    if (validation.error) {
        throw Object.assign(validation.error, { code: 'INVALID_PARAMETER', status: 400, expose: true });
    }

    return validation.value;
}

function validateName(name) {
    const validation = validateNpmPackageName(name);

    if (validation.errors) {
        throw Object.assign(new Error(`${validation.errors[0]} (module "${name}")`),
            { code: 'INVALID_PARAMETER', status: 400, expose: true });
    }

    return name;
}

function fetchScore(name, esClient) {
    return Promise.resolve(esClient.get({
        index: 'npms-read',
        type: 'module',
        id: name,
        _source: ['score.final'],
    }))
    .then((res) => get(res._source, 'score.final'))
    .then((score) => typeof score === 'number' ? Math.round(score * 100) : null)
    .catch({ status: 404 }, () => null);
}

// ----------------------------------------------------------

module.exports = (config, esClient) => {
    const badgeParamsSchema = Joi.object({
        name: Joi.string().required(),
        format: Joi.string().allow('svg', 'png', 'json').required(),
    }).required();
    const badgeQuerySchema = Joi.object({
        style: Joi.string().allow('flat', 'flat-square', 'plastic').default('flat'),
    }).required();

    const router = koaRouter();

    router.get('/:name.:format',
        function * (next) {
            this.validated = Object.assign(
                validateJoiSchema(badgeParamsSchema, this.params),
                validateJoiSchema(badgeQuerySchema, this.request.query)
            );
            validateName(this.validated.name);
            yield next;
        },
        function * () {
            const input = this.validated;

            // Fetch score & badge info
            const score = yield fetchScore(input.name, esClient);
            const badgeInfo = badgeVault.info(score, input.style, input.format);

            this.log.debug({ input, score, badgeInfo }, 'Got score and info');

            // Set ETag and see if the request is still fresh
            this.response.etag = badgeInfo.id;

            if (this.request.fresh) {
                this.log.debug({ input, score, badgeInfo }, 'Request is still fresh');
                this.status = 304;
                return;
            }

            // If format is json, simply output an object similar to shields.io json output
            if (input.format === 'json') {
                this.body = { name: 'npms score', value: score };
            // Otherwise, output the image that was pre-generated for the score
            } else {
                const badge = yield badgeVault.get(score, input.style, input.format);

                this.log.debug({ input, badgeInfo }, 'Got badge, sending..');

                this.body = badge.buffer;
                this.length = badge.stats.size;
                this.type = path.extname(badge.filePath);
            }

            // Set appropriate cache headers
            this.set('Cache-Control', badgeInfo.isUnknown ? 'public,no-cache' : `public,max-age=${config.maxAge}`);
        });

    return router.routes();
};