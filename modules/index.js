'use strict';

module.exports = function(app, cache, chance, database, io, self) {
    /* eslint global-require: 0 */
    require('./common')(app, cache, chance, database, io, self);
    require('./slack')(app, cache, chance, database, io, self);
    require('./users')(app, cache, chance, database, io, self);
    require('./chat')(app, cache, chance, database, io, self);
    require('./servers')(app, cache, chance, database, io, self);
    require('./games')(app, cache, chance, database, io, self);
    require('./draft')(app, cache, chance, database, io, self);
    require('./launch')(app, cache, chance, database, io, self);
    require('./players')(app, cache, chance, database, io, self);
    require('./admin')(app, cache, chance, database, io, self);
    require('./rules')(app, cache, chance, database, io, self);
    require('./discordbot')(app, cache, chance, database, io, self);
};
