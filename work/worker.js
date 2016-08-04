const _ = require('lodash');
const amqp = require('amqplib');
const asyncClass = require('async-class');
const co = require('co');
const config = require('config');
const moment = require('moment');

const helpers = require('../helpers');
const workFunctions = require('./functions');

const COMMAND_QUEUE = config.get('server.amqp.commandQueue');
const RESPONSE_EXCHANGE = config.get('server.amqp.responseExchange');
const QUEUE_CONNECT = config.get('server.amqp.connect');
const WORKER_MAX_TASKS = config.get('server.amqp.workerMaxTasks');

const PugChampWorker = asyncClass.wrap(class {
    constructor() {
        this.channel = null;
    }

    *
    initialize() {
        if (!this.channel) {
            let connection = yield amqp.connect(QUEUE_CONNECT);
            this.channel = yield connection.createChannel();

            yield this.channel.assertQueue(COMMAND_QUEUE);
            yield this.channel.prefetch(WORKER_MAX_TASKS);

            yield this.channel.assertExchange(RESPONSE_EXCHANGE, 'fanout');

            yield this.channel.consume(COMMAND_QUEUE, this.processTask.bind(this));
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
        let response = _.assign({
            start: moment().valueOf()
        }, task);

        try {
            let result = yield workFunctions[task.type](task, this);

            response.success = true;
            response.result = result;
        }
        catch (err) {
            response.success = false;
            response.error = err.message;
        }

        yield this.channel.publish(RESPONSE_EXCHANGE, '', helpers.convertJSONToBuffer(response));
    }
});

co(function*() {
    var worker = new PugChampWorker();
    yield worker.initialize();
});
