import { getTicks, getObjectsByPrototype } from '/game/utils';
import { StructureTower, Creep } from '/game/prototypes';
import { Flag } from '/arena/season_alpha/capture_the_flag/basic';

let _flagCache;
let _towerCache;
let _creepCache;
function _fillCaches() {
    if (_flagCache === undefined) {
        _flagCache = getObjectsByPrototype(Flag);
    }
    if (_towerCache === undefined) {
        _towerCache = getObjectsByPrototype(StructureTower);
    }
    if (_creepCache === undefined) {
        _creepCache = getObjectsByPrototype(Creep);
    }
}
class PlayerInfo {
    constructor() {
        this.creeps = [];
    }
}
function fillPlayerInfo(whoFunction) {
    _fillCaches();
    const playerInfo = new PlayerInfo();
    playerInfo.flag = _flagCache.find(x => whoFunction.apply(x));
    const towers = _towerCache.filter(x => whoFunction.apply(x));
    if (towers.length > 0)
        playerInfo.tower1 = towers[0];
    if (towers.length > 1)
        playerInfo.tower2 = towers[1];
    playerInfo.creeps = _creepCache.filter(x => whoFunction.apply(x));
    return playerInfo;
}
let myPlayerInfo;
let enemyPlayerInfo;
function loop() {
    if (getTicks() === 1) {
        myPlayerInfo = fillPlayerInfo(function my(what) {
            return what.my === true;
        });
        enemyPlayerInfo = fillPlayerInfo(function enemy(what) {
            return what.my === false;
        });
    }
    for (const creep of myPlayerInfo.creeps) {
        creep.moveTo(enemyPlayerInfo.flag);
    }
}

export { loop };
