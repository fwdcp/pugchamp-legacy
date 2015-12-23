module.exports = function(app, io, server) {
    require('./user')(app, io, server);
    require('./selection')(app, io, server);
}
