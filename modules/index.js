/* jshint node: true, esversion: 6, eqeqeq: true, latedef: true, undef: true, unused: true */
"use strict";

module.exports = function(app, database, io, self) {
    require('./common')(app, database, io, self);
    require('./slack')(app, database, io, self);
    require('./users')(app, database, io, self);
    require('./chat')(app, database, io, self);
    require('./servers')(app, database, io, self);
    require('./games')(app, database, io, self);
    require('./draft')(app, database, io, self);
    require('./launch')(app, database, io, self);
    require('./players')(app, database, io, self);
    require('./admin')(app, database, io, self);
};
