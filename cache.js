'use strict';

const bluebird = require('bluebird');
const config = require('config');
const redis = require('redis');

bluebird.promisifyAll(redis.RedisClient.prototype);
bluebird.promisifyAll(redis.Multi.prototype);

var client = redis.createClient(config.get('server.redis'));

module.exports = client;
