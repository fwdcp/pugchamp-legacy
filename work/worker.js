const amqp = require('amqplib');
const asyncClass = require('async-class');
const config = require('config');
const moment = require('moment');

const helpers = require('../helpers');
const workFunctions = require('./functions');

const COMMAND_QUEUE_NAME = config.get('server.amqp.commandQueue');
const RESPONSE_EXCHANGE_NAME = config.get('server.amqp.responseExchange');
const QUEUE_CONNECT = config.get('server.amqp.connect');
const WORKER_MAX_TASKS = config.get('server.amqp.workerMaxTasks');

class PugChampWorker {
    constructor() {
        this.channel = null;
    }

    *
    initialize() {
        if (!this.channel) {
            let connection = yield amqp.connect(QUEUE_CONNECT);
            this.channel = yield connection.createChannel();

            yield this.channel.assertQueue(COMMAND_QUEUE_NAME);
            yield this.channel.prefetch(WORKER_MAX_TASKS);

            yield this.channel.assertExchange(RESPONSE_EXCHANGE_NAME, 'fanout');

            yield this.channel.consume(COMMAND_QUEUE_NAME, this.processTask.bind(this));
        }
    }

    *
    processTask(msg) {
        let task = helpers.convertBufferToJSON(msg.contents);

        yield this.runTask(task);

        yield this.channel.ack(msg);
    }

    *
    runTask(task) {
        try {
            yield workFunctions[task.type](task, this);

            // TODO: notify that task is complete
        }
        catch (err) {
            // TODO: notify that task failed
        }
    }
}

module.exports = asyncClass.wrap(PugChampWorker);
