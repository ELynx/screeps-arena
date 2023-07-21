import { StructureTower, Creep } from '/game/prototypes';
import { RESOURCE_ENERGY, TOWER_ENERGY_COST, TOWER_OPTIMAL_RANGE, MOVE, TOWER_RANGE, ATTACK, HEAL, RANGED_ATTACK, RANGED_ATTACK_POWER, RANGED_ATTACK_DISTANCE_RATE, TOWER_FALLOFF, TOWER_FALLOFF_RANGE } from '/game/constants';
import { getTicks, getObjectsByPrototype, getRange } from '/game/utils';
import { Visual } from '/game/visual';
import { Flag } from '/arena/season_alpha/capture_the_flag/basic';

function sortById(a, b) {
    return a.id.toString().localeCompare(b.id.toString());
}
let _flagCache;
function allFlags() {
    if (_flagCache === undefined) {
        _flagCache = getObjectsByPrototype(Flag).sort(sortById);
    }
    return _flagCache;
}
let _towerCache;
function allTowers() {
    if (_towerCache === undefined) {
        _towerCache = getObjectsByPrototype(StructureTower).sort(sortById);
    }
    return _towerCache;
}
let _creepCache;
function allCreeps() {
    if (_creepCache === undefined) {
        _creepCache = getObjectsByPrototype(Creep).sort(sortById);
    }
    return _creepCache;
}
class PlayerInfo {
    constructor() {
        this.towers = [];
        this.creeps = [];
    }
}
function fillPlayerInfo(whoFunction) {
    const playerInfo = new PlayerInfo();
    playerInfo.flag = allFlags().find(whoFunction);
    playerInfo.towers = allTowers().filter(whoFunction);
    playerInfo.creeps = allCreeps().filter(whoFunction);
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
    play();
}
function exists(something) {
    if (something === undefined)
        return false;
    if (something.exists === false)
        return false;
    return true;
}
function operational(something) {
    if (!exists(something))
        return false;
    if (something.hits && something.hits <= 0)
        return false;
    return true;
}
function hasActiveBodyPart(creep, type) {
    return creep.body.some(function (bodyPart) {
        return bodyPart.hits > 0 && bodyPart.type === type;
    });
}
function notMaxHits(creep) {
    return creep.hits < creep.hitsMax;
}
function atSamePosition(a, b) {
    return a.x === b.x && a.y === b.y;
}
function towerPower(fullAmount, range) {
    if (range <= TOWER_OPTIMAL_RANGE)
        return fullAmount;
    const effectiveRange = Math.min(range, TOWER_FALLOFF_RANGE);
    const effectiveAmount = fullAmount * (1 - TOWER_FALLOFF * (effectiveRange - TOWER_OPTIMAL_RANGE) / (TOWER_FALLOFF_RANGE - TOWER_OPTIMAL_RANGE));
    return Math.floor(effectiveAmount);
}
class StructureTowerScore {
    constructor(creep, range) {
        this.creep = creep;
        this.range = range;
        this.score = this.calculateScore();
    }
    calculateScore() {
        // speed up process
        if (this.range > TOWER_RANGE)
            return 0;
        if (this.creep.my) {
            const hitsLost = this.creep.hitsMax - this.creep.hits;
            const percent = hitsLost / this.creep.hitsMax * 100;
            const withFalloff = towerPower(percent, this.range);
            return Math.round(withFalloff);
        }
        let bodyCost = 0;
        for (const bodyPart of this.creep.body) {
            if (bodyPart.hits <= 0)
                continue;
            // default pair of X + MOVE is 10 in sum
            // ignore mutants for simplicity
            if (bodyPart.type === ATTACK || bodyPart.type === HEAL)
                bodyCost += 6;
            else
                bodyCost += 4;
        }
        // again ignore mutants for simplicity
        const maxBodyCost = this.creep.body.length * 5;
        const percent = bodyCost / maxBodyCost * 100;
        const withFalloff = towerPower(percent, this.range);
        return Math.round(withFalloff);
    }
}
function operateTower(tower) {
    if (tower.cooldown > 0)
        return;
    if ((tower.store.getUsedCapacity(RESOURCE_ENERGY) || 0) < TOWER_ENERGY_COST)
        return;
    const saveEnergy = (tower.store.getFreeCapacity(RESOURCE_ENERGY) || 0) > TOWER_ENERGY_COST;
    const allCreepsInRange = allCreeps()
        .filter(operational)
        .filter(function (creep) {
        if (creep.my)
            return notMaxHits(creep);
        return true;
    })
        .map(function (creep) {
        const range = getRange(tower, creep);
        return new StructureTowerScore(creep, range);
    })
        .filter(function (target) {
        if (target.creep.my) {
            return target.range <= TOWER_OPTIMAL_RANGE * 3;
        }
        else {
            return target.range <= TOWER_OPTIMAL_RANGE * 2;
        }
    })
        .sort(function (a, b) {
        return b.score - a.score;
    });
    if (allCreepsInRange.length === 0)
        return;
    const target = allCreepsInRange[0];
    if (saveEnergy && target.score < 10)
        return;
    if (target.creep.my) {
        tower.heal(target.creep);
    }
    else {
        tower.attack(target.creep);
    }
}
class AttackableAndRange {
    constructor(attackable, range) {
        this.attackable = attackable;
        this.range = range;
    }
}
function autoMelee(creep, attackables) {
    if (!hasActiveBodyPart(creep, ATTACK))
        return;
    const inRange = creep.findInRange(attackables, 1);
    if (inRange.length > 0) {
        const target = inRange[0];
        creep.attack(target);
        new Visual().line(creep, target);
    }
}
function rangedMassAttackPower(target) {
    return RANGED_ATTACK_POWER * (RANGED_ATTACK_DISTANCE_RATE[target.range] || 0);
}
function autoRanged(creep, attackables) {
    if (!hasActiveBodyPart(creep, RANGED_ATTACK))
        return;
    const inRange = attackables.map(function (target) {
        const range = getRange(creep, target);
        return new AttackableAndRange(target, range);
    }).filter(function (target) {
        return target.range <= 3;
    });
    if (inRange.length === 0)
        return;
    const totalMassAttackPower = inRange.map(rangedMassAttackPower).reduce((sum, current) => sum + current, 0);
    if (totalMassAttackPower >= RANGED_ATTACK_POWER) {
        creep.rangedMassAttack();
    }
    else {
        const target = inRange[0].attackable;
        creep.rangedAttack(target);
        new Visual().line(creep, target);
    }
}
function autoHeal(creep, healables) {
    if (!hasActiveBodyPart(creep, HEAL))
        return;
    if (notMaxHits(creep)) {
        creep.heal(creep);
        return;
    }
    const inRange = healables.map(function (target) {
        const range = getRange(creep, target);
        return new AttackableAndRange(target, range);
    }).filter(function (target) {
        return target.range <= 3;
    });
    if (inRange.length === 0)
        return;
    const inTouch = inRange.find(function (target) {
        return target.range <= 1;
    });
    if (inTouch !== undefined) {
        creep.heal(inTouch.attackable);
    }
    else {
        const target = inRange[0].attackable;
        creep.rangedHeal(target);
        new Visual().line(creep, target);
    }
}
function autoAll(creep, attackables, healables) {
    autoMelee(creep, attackables);
    autoRanged(creep, attackables);
    autoHeal(creep, healables);
}
function autoCombat() {
    myPlayerInfo.towers.filter(operational).forEach(operateTower);
    const enemyCreeps = enemyPlayerInfo.creeps.filter(operational);
    const enemyTowers = enemyPlayerInfo.towers.filter(operational);
    const enemyAttackables = enemyCreeps.concat(enemyTowers);
    const myCreeps = myPlayerInfo.creeps.filter(operational);
    const myHealableCreeps = myCreeps.filter(notMaxHits);
    myCreeps.forEach(function (creep) {
        autoAll(creep, enemyAttackables, myHealableCreeps);
    });
}
class PositionGoal {
    constructor(creep, position) {
        this.creep = creep;
        this.position = position;
    }
}
function advancePositionGoal(positionGoal) {
    if (!operational(positionGoal.creep))
        return;
    if (positionGoal.creep.fatigue > 0)
        return;
    if (atSamePosition(positionGoal.creep, positionGoal.position))
        return;
    if (!hasActiveBodyPart(positionGoal.creep, MOVE))
        return;
    positionGoal.creep.moveTo(positionGoal.position);
}
class PositionStatistics {
    constructor(ranges) {
        this.numberOfCreeps = ranges.length;
        this.min = Number.MAX_SAFE_INTEGER;
        this.max = Number.MIN_SAFE_INTEGER;
        this.average = NaN;
        this.median = NaN;
        this.canReach = 0;
        if (this.numberOfCreeps === 0)
            return;
        const ticksLimit = 2000; // TODO arena info
        const ticksNow = getTicks();
        const ticksRemaining = ticksLimit - ticksNow;
        // for median
        const sorted = ranges.sort();
        let total = 0;
        for (let x of sorted) {
            if (x < this.min)
                this.min = x;
            if (x > this.max)
                this.max = x;
            this.canReach += x <= ticksRemaining ? 1 : 0;
            total += x;
        }
        this.average = total / this.numberOfCreeps;
        this.median = sorted[Math.floor(this.numberOfCreeps) / 2];
    }
    toString() {
        {
            return `No [${this.numberOfCreeps}] min [${this.min}] max [${this.max}] avg [${this.average}] mdn [${this.median}] reach [${this.canReach}] `;
        }
    }
}
function calculatePositionStatistics(creeps, position) {
    const ranges = creeps.filter(operational).map(function (creep) {
        return getRange(position, creep);
    });
    return new PositionStatistics(ranges);
}
function calculatePositionStatisticsForFlag(creeps, flag) {
    if (!exists(flag))
        return new PositionStatistics([]);
    return calculatePositionStatistics(creeps, flag);
}
let defendMyFlag = [];
let rushEnemyFlag = [];
function play() {
    if (getTicks() === 1) {
        for (const creep of myPlayerInfo.creeps) {
            if (myPlayerInfo.flag && myPlayerInfo.flag.y === creep.y) {
                defendMyFlag.push(new PositionGoal(creep, myPlayerInfo.flag));
                continue;
            }
            if (enemyPlayerInfo.flag) {
                rushEnemyFlag.push(new PositionGoal(creep, enemyPlayerInfo.flag));
            }
        }
    }
    const myAdvance = calculatePositionStatisticsForFlag(myPlayerInfo.creeps, enemyPlayerInfo.flag);
    console.log(myAdvance.toString());
    const enemyAdvance = calculatePositionStatisticsForFlag(enemyPlayerInfo.creeps, myPlayerInfo.flag);
    console.log(enemyAdvance.toString());
    defendMyFlag.forEach(advancePositionGoal);
    rushEnemyFlag.forEach(advancePositionGoal);
    autoCombat();
}

export { loop };
