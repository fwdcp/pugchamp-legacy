const _ = require('lodash');
const amqp = require('amqplib');
const asyncClass = require('async-class');
const co = require('co');
const config = require('config');
const moment = require('moment');

const COMMAND_QUEUE_NAME = config.get('server.amqp.commandQueue');
const RESPONSE_EXCHANGE_NAME = config.get('server.amqp.responseExchange');
const QUEUE_CONNECT = config.get('server.amqp.connect');

function convertJSONToBuffer(object) {
    return Buffer.from(JSON.stringify(object));
}

function convertBufferToJSON(buffer) {
    return JSON.parse(buffer.toString());
}

class PugChampWorkManager {
    constructor() {
        this.channel = null;
        this.queue = [];
    }

    *
    initialize() {
        if (!this.channel) {
            let connection = yield amqp.connect(QUEUE_CONNECT);
            this.channel = yield connection.createChannel();

            yield this.channel.assertQueue(COMMAND_QUEUE_NAME);

            yield this.channel.assertExchange(RESPONSE_EXCHANGE_NAME, 'fanout');
            let responseQueue = yield this.channel.assertQueue('', {
                exclusive: true
            });
            yield this.channel.bindQueue(responseQueue.queue, RESPONSE_EXCHANGE_NAME, '');

            yield this.channel.consume(responseQueue.queue, this.processResponse.bind(this));
        }
    }

    *
    queueTask(components, maxRuntime, maxWait) {
        return new Promise(co.wrap(function*(resolve, reject) {
            let newTask = {
                submitted: moment().valueOf(),
                components,
                maxRuntime,
                maxWait,
                onSuccess: resolve,
                onFailure: reject
            };

            this.queue.push(newTask);

            if (_.size(this.queue) === 1) {
                yield this.dispatchNextTask();
            }

            if (newTask.maxWait) {
                setTimeout(_.bind(function() {
                    this.onFailure(new Error('task waited too long'));

                    if (this.runtimeTimeout) {
                        clearTimeout(this.runtimeTimeout);
                    }

                    if (this.waitTimeout) {
                        clearTimeout(this.waitTimeout);
                    }
                }, newTask), newTask.maxWait);
            }
        }));
    }

    *
    dispatchNextTask() {
        if (_.size(this.queue) > 0) {
            let nextTask = _.head(this.queue);

            for (let component of nextTask.components) {
                yield this.channel.sendToQueue(COMMAND_QUEUE_NAME, convertJSONToBuffer(component), {
                    persistent: true
                });
            }

            if (nextTask.maxRuntime) {
                setTimeout(_.bind(function() {
                    this.onFailure(new Error('task timed out'));

                    if (this.runtimeTimeout) {
                        clearTimeout(this.runtimeTimeout);
                    }

                    if (this.waitTimeout) {
                        clearTimeout(this.waitTimeout);
                    }
                }, nextTask), nextTask.maxRuntime);
            }
        }
    }

    *
    processResponse(msg) {
        // TODO: implement
    }
}

module.exports = asyncClass.wrap(PugChampWorkManager);
