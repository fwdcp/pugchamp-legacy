'use strict';

module.exports = function(app, chance, database, io, self) {
    /* eslint global-require: 0 */
    require('./common')(app, chance, database, io, self);
    require('./slack')(app, chance, database, io, self);
    require('./users')(app, chance, database, io, self);
    require('./chat')(app, chance, database, io, self);
    require('./servers')(app, chance, database, io, self);
    require('./games')(app, chance, database, io, self);
    require('./draft')(app, chance, database, io, self);
    require('./launch')(app, chance, database, io, self);
    require('./players')(app, chance, database, io, self);
    require('./admin')(app, chance, database, io, self);
};
