module.exports = function(app, io, self, server) {
    require('./user')(app, io, self, server);
    require('./ready')(app, io, self, server);
};
