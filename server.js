var config = require('config');
var express = require('express');
var http = require('http');
var io = require('socket.io');

var app = express();
var server = http.Server(app);
var sockets = io(server);

server.listen(config.get('server.listen'));
