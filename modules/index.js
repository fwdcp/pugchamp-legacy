module.exports = function(app, io, server) {
    require('./user')(app, io, server);
}
