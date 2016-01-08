/* jshint node: true, esversion: 6, eqeqeq: true, latedef: true, undef: true, unused: true */
"use strict";

module.exports = function(app, io, self, server) {
    require('./user')(app, io, self, server);
    require('./launch')(app, io, self, server);
    require('./draft')(app, io, self, server);
    require('./servers')(app, io, self, server);
	require('./chat')(app, io, self, server);
};
