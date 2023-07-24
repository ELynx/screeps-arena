import { StructureTower, Creep } from '/game/prototypes';
import { ATTACK, RANGED_ATTACK, HEAL, ERR_NO_BODYPART, OK, RESOURCE_ENERGY, TOWER_ENERGY_COST, TOWER_OPTIMAL_RANGE, ERR_TIRED, ERR_INVALID_ARGS, TOWER_RANGE, RANGED_ATTACK_POWER, MOVE, RANGED_ATTACK_DISTANCE_RATE, TOWER_FALLOFF, TOWER_FALLOFF_RANGE } from '/game/constants';
import { getTicks, getCpuTime, getObjectsByPrototype, getRange, getDirection } from '/game/utils';
import { Visual } from '/game/visual';
import { Flag } from '/arena/season_alpha/capture_the_flag/basic';

// assumption, no constant given
const MAP_SIDE_SIZE = 100;
const TICK_LIMIT = 2000;
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
function myOwnable(what) {
    return what.my === true;
}
function enemyOwnable(what) {
    return what.my === false;
}
function fillPlayerInfo(whoFunction) {
    const playerInfo = new PlayerInfo();
    playerInfo.towers = allTowers().filter(whoFunction);
    playerInfo.creeps = allCreeps().filter(whoFunction);
    return playerInfo;
}
let myPlayerInfo;
let enemyPlayerInfo;
function collectPlayerInfo() {
    myPlayerInfo = fillPlayerInfo(myOwnable);
    enemyPlayerInfo = fillPlayerInfo(enemyOwnable);
}
function loop() {
    if (getTicks() === 1) {
        collectPlayerInfo();
        plan();
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
function getDirectionByPosition(from, to) {
    if (atSamePosition(from, to))
        return undefined;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    return getDirection(dx, dy);
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
        return this.creep.my ? this.calculateScoreMy() : this.calculateScoreEnemy();
    }
    calculateScoreMy() {
        const hitsLost = this.creep.hitsMax - this.creep.hits;
        const percent = hitsLost / this.creep.hitsMax * 100;
        const withFalloff = towerPower(percent, this.range);
        return Math.round(withFalloff);
    }
    calculateScoreEnemy() {
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
    const target = allCreepsInRange[0].creep;
    if (target.my) {
        tower.heal(target);
    }
    else {
        tower.attack(target);
    }
}
class AttackableAndRange {
    constructor(creep, attackable) {
        this.attackable = attackable;
        this.range = getRange(creep, attackable);
    }
}
function autoMelee(creep, attackables) {
    if (!hasActiveBodyPart(creep, ATTACK))
        return;
    const inRange = attackables.map(function (target) {
        return new AttackableAndRange(creep, target);
    }).filter(function (target) {
        return target.range <= 1;
    });
    if (inRange.length === 0)
        return;
    const target = inRange[0].attackable;
    creep.attack(target);
    new Visual().line(creep, target);
}
function rangedMassAttackPower(target) {
    return RANGED_ATTACK_POWER * (RANGED_ATTACK_DISTANCE_RATE[target.range] || 0);
}
function autoRanged(creep, attackables) {
    if (!hasActiveBodyPart(creep, RANGED_ATTACK))
        return;
    const inRange = attackables.map(function (target) {
        return new AttackableAndRange(creep, target);
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
        return new AttackableAndRange(creep, target);
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
    // attacking towers is possible, but not practical
    // const enemyCreeps = enemyPlayerInfo.creeps.filter(operational)
    // const enemyTowers = enemyPlayerInfo.towers.filter(operational)
    // const enemyAttackables = (enemyCreeps as Attackable[]).concat(enemyTowers as Attackable[])
    // attack only enemy creeps
    const enemyAttackables = enemyPlayerInfo.creeps.filter(operational);
    const myCreeps = myPlayerInfo.creeps.filter(operational);
    const myHealableCreeps = myCreeps.filter(notMaxHits);
    myCreeps.forEach(function (creep) {
        autoAll(creep, enemyAttackables, myHealableCreeps);
    });
}
class CreepLine {
    // head at index 0
    constructor(creeps) {
        this.creeps = creeps;
        // because head at index 0
        this.creeps.reverse();
    }
    move(direction) {
        const [rc, head] = this.chaseHead();
        if (rc !== OK)
            return rc;
        return head.move(direction);
    }
    moveTo(target, options) {
        const [rc, head] = this.chaseHead(options);
        if (rc !== OK)
            return rc;
        if (atSamePosition(head, target))
            return OK;
        return head.moveTo(target, options);
    }
    chaseHead(options) {
        const state = this.refreshState();
        if (state !== OK)
            return [state, undefined];
        // all !operational creeps are removed
        // all creeps can move
        // simple case
        if (this.creeps.length === 1)
            return [OK, this.creeps[0]];
        for (let i = 0; i < this.creeps.length - 1; ++i) {
            const current = this.creeps[i];
            const next = this.creeps[i + 1];
            const range = getRange(current, next);
            if (range === 1) {
                // just a step
                const direction = getDirectionByPosition(current, next);
                current.move(direction); // because range 1 should work
            }
            else if (range > 1) {
                current.moveTo(next, options);
                // give time to catch up
                return [ERR_TIRED, undefined];
            }
            else {
                // just to cover the case
                return [ERR_INVALID_ARGS, undefined];
            }
        }
        // return head for command
        return [OK, this.creeps[this.creeps.length - 1]];
    }
    refreshState() {
        this.creeps = this.creeps.filter(operational);
        if (this.creeps.length === 0)
            return ERR_NO_BODYPART;
        for (const creep of this.creeps) {
            if (creep.fatigue > 0)
                return ERR_TIRED;
            if (!hasActiveBodyPart(creep, MOVE))
                return ERR_NO_BODYPART;
        }
        return OK;
    }
}
class Rotator {
    constructor(anchor) {
        this.anchor = anchor;
        this.offset = { x: 0, y: 0 };
        this.positions = [];
    }
    setOffset(offset) {
        this.offset = offset;
    }
    with(position) {
        const shifted = { x: position.x + this.offset.x, y: position.y + this.offset.y };
        this.positions.push(shifted);
    }
    rotate0() {
    }
    rotate90() {
        this.rotateImpl(0, -1, 1, 0);
    }
    rotate180() {
        this.rotateImpl(-1, 0, 0, -1);
    }
    rotate270() {
        this.rotateImpl(0, 1, -1, 0);
    }
    // . x ------>
    // y 0    90
    // | 270 180
    // v
    autoRotate() {
        const half = Math.round(MAP_SIDE_SIZE / 2);
        if (this.anchor.x < half) {
            if (this.anchor.y < half) {
                this.rotate0();
            }
            else {
                this.rotate270();
            }
        }
        else {
            if (this.anchor.y < half) {
                this.rotate90();
            }
            else {
                this.rotate180();
            }
        }
    }
    rotateImpl(x2x, y2x, x2y, y2y) {
        for (const position of this.positions) {
            const x = position.x * x2x + position.y * y2x;
            const y = position.x * x2y + position.y * y2y;
            // for whatever weirdness that may follow
            position.x = Math.round(x);
            position.y = Math.round(y);
        }
    }
    build() {
        for (const position of this.positions) {
            const x = this.anchor.x + position.x;
            const y = this.anchor.y + position.y;
            position.x = x;
            position.y = y;
        }
    }
}
function advance(positionGoal) {
    positionGoal.advance();
}
class SingleCreepPositionGoal {
    constructor(creep, position) {
        this.creep = creep;
        this.position = position;
    }
    advance(options) {
        if (!operational(this.creep))
            return ERR_NO_BODYPART;
        if (atSamePosition(this.creep, this.position))
            return OK;
        return this.creep.moveTo(this.position, options);
    }
}
class GridPositionGoal {
    constructor(creeps, positions) {
        this.creeps = creeps;
        this.positions = positions;
    }
    advance(options) {
        // error case
        if (this.creeps.length !== this.positions.length)
            return ERR_INVALID_ARGS;
        // elimination case
        if (!this.creeps.some(operational))
            return ERR_NO_BODYPART;
        let totalRc = OK;
        for (let i = 0; i < this.creeps.length; ++i) {
            const creep = this.creeps[i];
            const position = this.positions[i];
            const oneRc = this.advanceOne(creep, position, options);
            if (oneRc < totalRc)
                totalRc = oneRc; // less than because error codes are negatives
        }
        return totalRc;
    }
    advanceOne(creep, position, options) {
        if (!operational(creep))
            return OK; // fallback for the fallen, overall group is OK
        if (atSamePosition(creep, position))
            return OK;
        return creep.moveTo(position, options);
    }
}
class GridPositionGoalBuilder extends Rotator {
    constructor(anchor) {
        super(anchor);
        this.creeps = [];
    }
    static around(position) {
        return new GridPositionGoalBuilder(position);
    }
    setOffset(offset) {
        super.setOffset(offset);
        return this;
    }
    setOffsetXY(x, y) {
        const position = { x, y };
        super.setOffset(position);
        return this;
    }
    withCreepToPosition(creep, position) {
        this.creeps.push(creep);
        super.with(position);
        return this;
    }
    withCreepToXY(creep, x, y) {
        const position = { x, y };
        return this.withCreepToPosition(creep, position);
    }
    rotate0() {
        super.rotate0();
        return this;
    }
    rotate90() {
        super.rotate90();
        return this;
    }
    rotate180() {
        super.rotate180();
        return this;
    }
    rotate270() {
        super.rotate270();
        return this;
    }
    autoRotate() {
        super.autoRotate();
        return this;
    }
    build() {
        super.build();
        return new GridPositionGoal(this.creeps, this.positions);
    }
}
class LinePositionGoal {
    constructor(creeps, position) {
        this.creepLine = new CreepLine(creeps);
        this.position = position;
    }
    advance(options) {
        return this.creepLine.moveTo(this.position, options);
    }
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
        const ticksNow = getTicks();
        const ticksRemaining = TICK_LIMIT - ticksNow;
        // for median
        const sorted = ranges.sort();
        let total = 0;
        for (const x of sorted) {
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
    static forCreepsAndPosition(creeps, position) {
        const ranges = creeps.filter(operational).map(function (creep) {
            return getRange(position, creep);
        });
        return new PositionStatistics(ranges);
    }
    static forCreepsAndFlag(creeps, flag) {
        if (!exists(flag))
            return new PositionStatistics([]);
        return PositionStatistics.forCreepsAndPosition(creeps, flag);
    }
    toString() {
        return `No [${this.numberOfCreeps}] min [${this.min}] max [${this.max}] average [${this.average}] median [${this.median}] reach [${this.canReach}] `;
    }
}
class CreepFilter {
    constructor(bodyTypes, positions) {
        this.bodyTypes = bodyTypes;
        this.positions = positions;
    }
    // returns [found creeps in specified order, remainder]
    // uses all or nothing approach, if one requested is not found, all are dropped
    filter(creeps) {
        if (this.positions.length !== this.bodyTypes.length)
            return [[], creeps];
        const found = new Array(this.positions.length);
        const remainder = [];
        for (const creep of creeps) {
            let positionNotFound = true;
            for (let i = 0; i < this.positions.length && positionNotFound; ++i) {
                const position = this.positions[i];
                if (atSamePosition(creep, position)) {
                    if (hasActiveBodyPart(creep, this.bodyTypes[i])) {
                        found[i] = creep;
                        positionNotFound = false;
                    }
                    else {
                        return [[], creeps];
                    }
                }
            }
            if (positionNotFound)
                remainder.push(creep);
        }
        for (const x of found) {
            if (x === undefined)
                return [[], creeps];
        }
        return [found, remainder];
    }
}
class CreepFilterBuilder extends Rotator {
    constructor(anchor) {
        super(anchor);
        this.bodyTypes = [];
    }
    static around(position) {
        return new CreepFilterBuilder(position);
    }
    setOffset(offset) {
        super.setOffset(offset);
        return this;
    }
    setOffsetXY(x, y) {
        const position = { x, y };
        return this.setOffset(position);
    }
    withBodyTypeAtPosition(bodyType, position) {
        this.bodyTypes.push(bodyType);
        super.with(position);
        return this;
    }
    withBodyTypeAtXY(bodyType, x, y) {
        const position = { x, y };
        return this.withBodyTypeAtPosition(bodyType, position);
    }
    rotate0() {
        super.rotate0();
        return this;
    }
    rotate90() {
        super.rotate90();
        return this;
    }
    rotate180() {
        super.rotate180();
        return this;
    }
    rotate270() {
        super.rotate270();
        return this;
    }
    autoRotate() {
        super.autoRotate();
        return this;
    }
    build() {
        super.build();
        return new CreepFilter(this.bodyTypes, this.positions);
    }
}
let myFlag;
let enemyFlag;
let enemyStartDistance;
const unexpectedCreepsGoals = [];
const rushRandomAll = [];
const rushWithTwoLines = [];
const rushRandomWithDoorstep = [];
const defenceGoals = [];
function handleUnexpectedCreeps(creeps) {
    for (const creep of creeps) {
        console.log('Unexpected creep ', creep);
        if (enemyFlag) {
            unexpectedCreepsGoals.push(new SingleCreepPositionGoal(creep, enemyFlag));
        }
    }
}
function plan() {
    myFlag = allFlags().find(myOwnable);
    if (myFlag === undefined) {
        console.log('myFlag not found');
        handleUnexpectedCreeps(myPlayerInfo.creeps);
        return;
    }
    enemyFlag = allFlags().find(enemyOwnable);
    if (enemyFlag === undefined) {
        console.log('enemyFlag not found');
        handleUnexpectedCreeps(myPlayerInfo.creeps);
        return;
    }
    // check if all expected creeps are in place
    const myCreepsFilter = CreepFilterBuilder.around(myFlag)
        .setOffsetXY(-3, -3)
        .withBodyTypeAtXY(ATTACK, 8, 7)
        .withBodyTypeAtXY(ATTACK, 7, 8)
        .withBodyTypeAtXY(RANGED_ATTACK, 8, 6)
        .withBodyTypeAtXY(RANGED_ATTACK, 6, 8)
        .withBodyTypeAtXY(RANGED_ATTACK, 8, 5)
        .withBodyTypeAtXY(RANGED_ATTACK, 5, 8)
        .withBodyTypeAtXY(RANGED_ATTACK, 8, 4)
        .withBodyTypeAtXY(RANGED_ATTACK, 4, 8)
        .withBodyTypeAtXY(HEAL, 8, 3)
        .withBodyTypeAtXY(HEAL, 3, 8)
        .withBodyTypeAtXY(HEAL, 8, 2)
        .withBodyTypeAtXY(HEAL, 2, 8)
        .withBodyTypeAtXY(HEAL, 8, 1)
        .withBodyTypeAtXY(HEAL, 1, 8)
        .autoRotate()
        .build();
    const [expected, unexpected] = myCreepsFilter.filter(myPlayerInfo.creeps);
    if (expected.length === 0) {
        console.log('Creeps are not on expected positions');
        handleUnexpectedCreeps(myPlayerInfo.creeps);
        return;
    }
    if (unexpected.length > 0) {
        console.log('Unexpected creeps detected');
        handleUnexpectedCreeps(unexpected);
    }
    expected.forEach(function (creep) {
        rushRandomAll.push(new SingleCreepPositionGoal(creep, enemyFlag));
    });
    const doorstopFilter = CreepFilterBuilder.around(myFlag)
        .setOffsetXY(-3, -3)
        .withBodyTypeAtXY(HEAL, 8, 1)
        .autoRotate()
        .build();
    const [doorstopCreeps] = doorstopFilter.filter(myPlayerInfo.creeps);
    const doorstep = new SingleCreepPositionGoal(doorstopCreeps[0], myFlag);
    rushWithTwoLines.push(doorstep);
    rushRandomWithDoorstep.push(doorstep);
    defenceGoals.push(doorstep);
    const line1Filter = CreepFilterBuilder.around(myFlag)
        .setOffsetXY(-3, -3)
        .withBodyTypeAtXY(ATTACK, 8, 7)
        .withBodyTypeAtXY(HEAL, 8, 3)
        .withBodyTypeAtXY(RANGED_ATTACK, 8, 6)
        .withBodyTypeAtXY(HEAL, 8, 2)
        .withBodyTypeAtXY(RANGED_ATTACK, 8, 5)
        // doorstep
        .withBodyTypeAtXY(RANGED_ATTACK, 8, 4)
        .autoRotate()
        .build();
    const [line1Creeps] = line1Filter.filter(myPlayerInfo.creeps);
    rushWithTwoLines.push(new LinePositionGoal(line1Creeps, enemyFlag));
    line1Creeps.forEach(function (creep) {
        rushRandomWithDoorstep.push(new SingleCreepPositionGoal(creep, enemyFlag));
    });
    const line2Filter = CreepFilterBuilder.around(myFlag)
        .setOffsetXY(-3, -3)
        .withBodyTypeAtXY(ATTACK, 7, 8)
        .withBodyTypeAtXY(HEAL, 3, 8)
        .withBodyTypeAtXY(RANGED_ATTACK, 6, 8)
        .withBodyTypeAtXY(HEAL, 2, 8)
        .withBodyTypeAtXY(RANGED_ATTACK, 5, 8)
        .withBodyTypeAtXY(HEAL, 1, 8)
        .withBodyTypeAtXY(RANGED_ATTACK, 4, 8)
        .autoRotate()
        .build();
    const [line2Creeps] = line2Filter.filter(myPlayerInfo.creeps);
    rushWithTwoLines.push(new LinePositionGoal(line2Creeps, enemyFlag));
    line2Creeps.forEach(function (creep) {
        rushRandomWithDoorstep.push(new SingleCreepPositionGoal(creep, enemyFlag));
    });
    defenceGoals.push(GridPositionGoalBuilder.around(myFlag)
        .setOffsetXY(-3, -3)
        .withCreepToXY(line1Creeps[0], 1, 0)
        .withCreepToXY(line1Creeps[1], 0, -1)
        .withCreepToXY(line1Creeps[2], 1, -2)
        .withCreepToXY(line1Creeps[3], 2, -1)
        .withCreepToXY(line1Creeps[4], 3, -1)
        .withCreepToXY(line1Creeps[5], 4, -1)
        .withCreepToXY(line2Creeps[0], 0, 1)
        .withCreepToXY(line2Creeps[1], -1, 0)
        .withCreepToXY(line2Creeps[2], -2, 1)
        .withCreepToXY(line2Creeps[3], -1, 2)
        .withCreepToXY(line2Creeps[4], -1, 3)
        .withCreepToXY(line2Creeps[5], -2, 3)
        .withCreepToXY(line2Creeps[6], -1, 4)
        .autoRotate()
        .build());
    console.log('Planning complete at ' + getCpuTime());
}
function advanceGoals() {
    unexpectedCreepsGoals.forEach(advance);
    if (myFlag === undefined || enemyFlag === undefined)
        return;
    const enemyAdvance = PositionStatistics.forCreepsAndFlag(enemyPlayerInfo.creeps, myFlag);
    if (enemyStartDistance === undefined) {
        enemyStartDistance = enemyAdvance.min;
    }
    const endspiel = getTicks() >= TICK_LIMIT - (MAP_SIDE_SIZE * 2);
    if (enemyAdvance.canReach === 0) {
        if (endspiel) {
            console.log('A. rushRandomAll');
            rushRandomAll.forEach(advance);
        }
        else {
            console.log('B. rushWithTwoLines');
            rushWithTwoLines.forEach(advance);
        }
        return;
    }
    const myDefence = PositionStatistics.forCreepsAndFlag(myPlayerInfo.creeps, myFlag);
    if (enemyAdvance.min < enemyStartDistance && enemyAdvance.median <= myDefence.median) {
        console.log('C. defenceGoals');
        defenceGoals.forEach(advance);
        return;
    }
    if (endspiel) {
        console.log('D. rushRandomWithDoorstep');
        rushRandomWithDoorstep.forEach(advance);
    }
    else {
        console.log('E. rushWithTwoLines');
        rushWithTwoLines.forEach(advance);
    }
}
function play() {
    advanceGoals();
    autoCombat();
}

export { loop };
