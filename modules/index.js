/* jshint node: true, esversion: 6, eqeqeq: true, latedef: true, undef: true, unused: true */
"use strict";

module.exports = function(app, database, io, self, server) {
    require('./user')(app, database, io, self, server);
    require('./launch')(app, database, io, self, server);
    require('./draft')(app, database, io, self, server);
    require('./servers')(app, database, io, self, server);
    require('./games')(app, database, io, self, server);
    require('./admin')(app, database, io, self, server);
    require('./players')(app, database, io, self, server);
    require('./chat')(app, database, io, self, server);
};
