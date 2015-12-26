module.exports = function(app, io, self, server) {
    require('./user')(app, io, self, server);
    require('./launch')(app, io, self, server);
};
