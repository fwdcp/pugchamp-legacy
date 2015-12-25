module.exports = function(app, io, self, server) {
    require('./user')(app, io, self, server);
    require('./selection')(app, io, self, server);
};
