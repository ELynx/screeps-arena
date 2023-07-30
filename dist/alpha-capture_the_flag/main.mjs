import assignToGrids from './node_modules/grid-assign-js/dist/lap-jv/index.mjs';
import { StructureTower, Creep } from '/game/prototypes';
import { ATTACK, RANGED_ATTACK, HEAL, ERR_NO_BODYPART, OK, RESOURCE_ENERGY, TOWER_ENERGY_COST, TOWER_OPTIMAL_RANGE, TOUGH, ERR_TIRED, ERR_INVALID_ARGS, TOWER_RANGE, ERR_NOT_IN_RANGE, RANGED_ATTACK_POWER, MOVE, RANGED_ATTACK_DISTANCE_RATE, TOWER_FALLOFF, TOWER_FALLOFF_RANGE } from '/game/constants';
import { getTicks, getCpuTime, getObjectsByPrototype, getRange, getDirection } from '/game/utils';
import { Visual } from '/game/visual';
import { Flag, BodyPart } from '/arena/season_alpha/capture_the_flag/basic';

// assumption, no constant given
const MAP_SIDE_SIZE = 100;
const TICK_LIMIT = 2000;
// derived constants
const MAP_SIDE_SIZE_SQRT = Math.round(Math.sqrt(MAP_SIDE_SIZE));
/**
 * Returns buggy but useful distance metric
 * @param a 1st position
 * @param b 2nd position
 */
function get8WayGridRange(a, b) {
    return Math.min(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}
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
function countActiveBodyParts(creep) {
    const result = new Map();
    for (const bodyPart of creep.body) {
        if (bodyPart.hits > 0) {
            const now = result.get(bodyPart.type) || 0;
            result.set(bodyPart.type, now + 1);
        }
    }
    return result;
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
function autoMeleeAttack(creep, attackables) {
    const inRange = attackables.map(function (target) {
        return new AttackableAndRange(creep, target);
    }).filter(function (target) {
        return target.range <= 1;
    });
    if (inRange.length === 0)
        return ERR_NOT_IN_RANGE;
    const target = inRange[0].attackable;
    new Visual().line(creep, target, { color: '#f93842' });
    return creep.attack(target);
}
function rangedMassAttackPower(target) {
    return RANGED_ATTACK_POWER * (RANGED_ATTACK_DISTANCE_RATE[target.range] || 0);
}
function autoRangedAttack(creep, attackables) {
    const inRange = attackables.map(function (target) {
        return new AttackableAndRange(creep, target);
    }).filter(function (target) {
        return target.range <= 3;
    });
    if (inRange.length === 0)
        return ERR_NOT_IN_RANGE;
    const totalMassAttackPower = inRange.map(rangedMassAttackPower).reduce((sum, current) => sum + current, 0);
    if (totalMassAttackPower >= RANGED_ATTACK_POWER) {
        return creep.rangedMassAttack();
    }
    else {
        const target = inRange[0].attackable;
        return creep.rangedAttack(target);
    }
}
function autoSelfHeal(creep) {
    if (notMaxHits(creep))
        return creep.heal(creep);
    return ERR_NOT_IN_RANGE;
}
function autoMeleeHeal(creep, healables) {
    const inRange = healables.map(function (target) {
        return new AttackableAndRange(creep, target);
    }).filter(function (target) {
        // voluntary, self heal handled elsewhere
        return target.range <= 1 && target.attackable.id !== creep.id;
    });
    if (inRange.length === 0)
        return ERR_NOT_IN_RANGE;
    const target = inRange[0].attackable;
    new Visual().line(creep, target, { color: '#65fd62' });
    return creep.heal(target);
}
function autoRangedHeal(creep, healables) {
    const inRange = healables.map(function (target) {
        return new AttackableAndRange(creep, target);
    }).filter(function (target) {
        // mandatory, ranged does not work on self
        return target.range <= 3 && target.attackable.id !== creep.id;
    });
    if (inRange.length === 0)
        return ERR_NOT_IN_RANGE;
    const target = inRange[0].attackable;
    return creep.rangedHeal(target);
}
function autoAll(creep, attackables, healables) {
    // https://docs.screeps.com/simultaneous-actions.html
    const counts = countActiveBodyParts(creep);
    const tough = counts.get(TOUGH) || 0;
    const melee = counts.get(ATTACK) || 0;
    const ranged = counts.get(RANGED_ATTACK) || 0;
    const heal = counts.get(HEAL) || 0;
    // solve simple cases
    if (melee === 0 && ranged === 0 && heal === 0)
        return;
    if (melee > 0 && ranged === 0 && heal === 0) {
        autoMeleeAttack(creep, attackables);
        return;
    }
    if (melee === 0 && ranged > 0 && heal === 0) {
        autoRangedAttack(creep, attackables);
        return;
    }
    if (melee === 0 && ranged === 0 && heal > 0) {
        if (autoSelfHeal(creep) === OK)
            return;
        if (autoMeleeHeal(creep, healables) === OK)
            return;
        autoRangedHeal(creep, healables);
        return;
    }
    if (heal === 0) {
        autoMeleeAttack(creep, attackables);
        autoRangedAttack(creep, attackables);
        return;
    }
    // solve medium cases
    const asHealAsPossible = function () {
        if (autoSelfHeal(creep) === OK) {
            autoRangedAttack(creep, attackables);
            return;
        }
        if (autoMeleeHeal(creep, healables) === OK) {
            autoRangedAttack(creep, attackables);
            return;
        }
        if (ranged > heal) {
            if (autoRangedAttack(creep, attackables) === OK)
                return;
            autoRangedHeal(creep, healables);
        }
        else {
            if (autoRangedHeal(creep, healables) === OK)
                return;
            autoRangedAttack(creep, attackables);
        }
    };
    if (melee === 0) {
        asHealAsPossible();
        return;
    }
    // solve complex cases
    const meleeThenHeal = function () {
        if (autoMeleeAttack(creep, attackables) === OK) {
            autoRangedAttack(creep, attackables);
            return;
        }
        asHealAsPossible();
    };
    if (tough > 0) {
        meleeThenHeal();
        return;
    }
    if (melee > heal) {
        meleeThenHeal();
        return;
    }
    if (autoSelfHeal(creep) === OK) {
        autoRangedAttack(creep, attackables);
        return;
    }
    if (autoMeleeHeal(creep, healables) === OK) {
        autoRangedAttack(creep, attackables);
        return;
    }
    if (heal >= ranged) {
        if (autoRangedHeal(creep, healables) === OK)
            return;
    }
    if (autoRangedAttack(creep, attackables) === OK) {
        autoMeleeAttack(creep, attackables);
    }
    if (autoRangedHeal(creep, healables) === OK)
        return;
    autoMeleeAttack(creep, attackables);
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
        // safeguard against array modifications
        this.creeps = creeps.concat();
    }
    move(direction, options) {
        const [rc, loco] = this.chaseLoco(options);
        if (rc !== OK)
            return rc;
        return loco.move(direction);
    }
    moveTo(target, options) {
        const [rc, loco] = this.chaseLoco(options);
        if (rc !== OK)
            return rc;
        if (atSamePosition(loco, target))
            return OK;
        return loco.moveTo(target, options);
    }
    locoToWagonIndex(magicNumber, options) {
        return magicNumber;
    }
    wagonToLocoIndex(magicNumber, options) {
        return this.creeps.length - 1 - magicNumber;
    }
    cost(target, options) {
        for (let i = 0; i < this.creeps.length; ++i) {
            const ri = this.locoToWagonIndex(i, options);
            const loco = this.creeps[ri];
            if (operational(loco)) {
                return get8WayGridRange(loco, target);
            }
        }
        return Number.MAX_SAFE_INTEGER;
    }
    chaseLoco(options) {
        const state = this.refreshState();
        if (state !== OK)
            return [state, undefined];
        // all !operational creeps are removed
        // all creeps can move
        // simple case
        if (this.creeps.length === 1)
            return [OK, this.creeps[0]];
        for (let i = 0; i < this.creeps.length - 1; ++i) {
            const ri0 = this.wagonToLocoIndex(i, options);
            const ri1 = this.wagonToLocoIndex(i + 1, options);
            const current = this.creeps[ri0];
            const next = this.creeps[ri1];
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
        const locoIndex = this.locoToWagonIndex(0, options);
        return [OK, this.creeps[locoIndex]];
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
class CreepPositionGoal {
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
    cost(options) {
        if (!operational(this.creep))
            return Number.MAX_SAFE_INTEGER;
        return get8WayGridRange(this.creep, this.position);
    }
}
class GridCreepPositionGoalBuilder extends Rotator {
    constructor(anchor) {
        super(anchor);
        this.creeps = [];
    }
    static around(position) {
        return new GridCreepPositionGoalBuilder(position);
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
        if (this.creeps.length !== this.positions.length)
            return [];
        const result = new Array(this.creeps.length);
        for (let i = 0; i < this.creeps.length; ++i) {
            result[i] = new CreepPositionGoal(this.creeps[i], this.positions[i]);
        }
        return result;
    }
}
class LinePositionGoal {
    constructor(creepLine, position) {
        this.creepLine = creepLine;
        this.position = position;
    }
    static of(creeps, position) {
        const creepLine = new CreepLine(creeps);
        return new LinePositionGoal(creepLine, position);
    }
    advance(options) {
        return this.creepLine.moveTo(this.position, options);
    }
    cost(options) {
        return this.creepLine.cost(this.position, options);
    }
}
class BodyPartGoal {
    constructor() {
        this.creeps = [];
    }
    addCreep(creep) {
        this.creeps.push(creep);
    }
    advance(options) {
        const allBodyPards = getObjectsByPrototype(BodyPart);
        if (allBodyPards.length === 0)
            return OK;
        const bodyPartsOfType = function (type) {
            return allBodyPards.filter(function (bodyPart) {
                return bodyPart.type === type;
            });
        };
        this.creeps = this.creeps.filter(operational);
        if (this.creeps.length === 0)
            return ERR_NO_BODYPART;
        const notEnoughMove = function (creep) {
            let balance = 0;
            for (const bodyPart of creep.body) {
                if (bodyPart.type === MOVE)
                    ++balance;
                else
                    --balance;
            }
            return balance < 0;
        };
        const allCreeps = this.creeps;
        const creepsWithNotEnoughMove = allCreeps.filter(notEnoughMove);
        const creepsWithBodyPart = function (type) {
            return allCreeps.filter(function (creep) {
                return creep.body.some(function (bodyPart) {
                    return bodyPart.type === type;
                });
            });
        };
        const goals = new Map();
        const addToGoalsPerCreep = function (goal) {
            goals.set(goal.creep.id.toLocaleString(), goal);
        };
        BodyPartGoal.goalsForGroup(allCreeps, bodyPartsOfType(TOUGH)).forEach(addToGoalsPerCreep);
        BodyPartGoal.goalsForGroup(allCreeps, bodyPartsOfType(MOVE)).forEach(addToGoalsPerCreep);
        BodyPartGoal.goalsForGroup(creepsWithBodyPart(ATTACK), bodyPartsOfType(ATTACK)).forEach(addToGoalsPerCreep);
        BodyPartGoal.goalsForGroup(creepsWithBodyPart(RANGED_ATTACK), bodyPartsOfType(RANGED_ATTACK)).forEach(addToGoalsPerCreep);
        BodyPartGoal.goalsForGroup(creepsWithBodyPart(HEAL), bodyPartsOfType(HEAL)).forEach(addToGoalsPerCreep);
        BodyPartGoal.goalsForGroup(creepsWithNotEnoughMove, bodyPartsOfType(MOVE)).forEach(addToGoalsPerCreep);
        let totalRc = OK;
        for (const goal of goals.values()) {
            const rc = goal.advance(options);
            if (rc < totalRc)
                totalRc = rc;
        }
        return totalRc;
    }
    static goalsForGroup(creeps, bodyParts) {
        if (bodyParts.length === 0)
            return [];
        if (creeps.length === 0)
            return [];
        let expandedBodyParts = bodyParts;
        while (expandedBodyParts.length < creeps.length) {
            expandedBodyParts = expandedBodyParts.concat(bodyParts);
        }
        const actors = [];
        for (let i = 0; i < creeps.length; ++i) {
            const creep = creeps[i];
            actors.push([creep.x, creep.y, -creep.fatigue]);
        }
        const targetPoints = [];
        for (let i = 0; i < expandedBodyParts.length; ++i) {
            const bodyPart = expandedBodyParts[i];
            targetPoints.push([bodyPart.x, bodyPart.y, bodyPart.ticksToDecay]);
        }
        const COST_NO_ASSIGN = 100000;
        const distanceMetric = function (actor, targetPoint) {
            const dx = Math.abs(actor[0] - targetPoint[0]);
            const dy = Math.abs(actor[1] - targetPoint[1]);
            const dt = Math.abs(actor[2] - targetPoint[2]);
            const flatRange = Math.max(dx, dy);
            // with some extra time for swamp and corners
            if (flatRange > dt - MAP_SIDE_SIZE_SQRT)
                return COST_NO_ASSIGN;
            return flatRange;
        };
        const assignments = assignToGrids({
            assignTo: actors,
            points: targetPoints,
            distanceMetric
        });
        const result = [];
        for (let actorIndex = 0; actorIndex < assignments.length; ++actorIndex) {
            const targetIndex = assignments[actorIndex];
            // since there is no cost returned, do manual extra check
            const actor = actors[actorIndex];
            const targetPoint = targetPoints[targetIndex];
            const cost = distanceMetric(actor, targetPoint);
            if (cost >= COST_NO_ASSIGN)
                continue;
            const creep = creeps[actorIndex];
            const bodyPart = expandedBodyParts[targetIndex];
            const goal = new CreepPositionGoal(creep, bodyPart);
            result.push(goal);
        }
        return result;
    }
    cost(options) {
        // too fractal to calculate
        return MAP_SIDE_SIZE / 2;
    }
}
class AndGoal {
    constructor(goals) {
        this.goals = goals;
    }
    advance(options) {
        if (this.goals.length === 0)
            return ERR_INVALID_ARGS;
        let resultRc = OK;
        for (const goal of this.goals) {
            const rc = goal.advance(options);
            if (rc < resultRc)
                resultRc = rc; // ERR_ are negative
        }
        return resultRc;
    }
    cost(options) {
        if (this.goals.length === 0)
            return Number.MAX_SAFE_INTEGER;
        let maxCost = Number.MIN_SAFE_INTEGER;
        for (const goal of this.goals) {
            const cost = goal.cost(options);
            if (cost > maxCost)
                maxCost = cost;
        }
        return maxCost;
    }
}
class OrGoal {
    constructor(goals) {
        this.goals = goals;
    }
    advance(options) {
        if (this.goals.length === 0)
            return ERR_INVALID_ARGS;
        let minCost = Number.MAX_SAFE_INTEGER; // also filter out other MAX_...
        let minIndex = -1;
        for (let i = 0; i < this.goals.length; ++i) {
            const goalCost = this.goals[i].cost(options);
            if (goalCost < minCost) {
                minCost = goalCost;
                minIndex = i;
            }
        }
        if (minIndex < 0)
            return ERR_NO_BODYPART;
        return this.goals[minIndex].advance(options);
    }
    cost(options) {
        if (this.goals.length === 0)
            return Number.MAX_SAFE_INTEGER;
        let minCost = Number.MAX_SAFE_INTEGER;
        for (const goal of this.goals) {
            const cost = goal.cost(options);
            if (cost < minCost)
                minCost = cost;
        }
        return minCost;
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
class PositionStatistics {
    constructor(ranges) {
        this.numberOfCreeps = ranges.length;
        this.min = Number.MAX_SAFE_INTEGER;
        this.min2nd = Number.MAX_SAFE_INTEGER;
        this.max = Number.MIN_SAFE_INTEGER;
        this.median = NaN;
        this.canReach = 0;
        if (this.numberOfCreeps === 0)
            return;
        const sorted = ranges.sort();
        this.min = sorted[0];
        this.min2nd = sorted.length > 1 ? sorted[1] : sorted[0];
        this.max = sorted[sorted.length - 1];
        this.median = sorted[Math.floor(sorted.length / 2)];
        const ticksRemaining = TICK_LIMIT - getTicks();
        if (sorted[0] > ticksRemaining) {
            this.canReach = 0;
        }
        else if (sorted[sorted.length - 1] <= ticksRemaining) {
            this.canReach = sorted.length;
        }
        else {
            this.canReach = sorted.findIndex(function (range) {
                return range > ticksRemaining;
            });
        }
    }
    static forCreepsAndPosition(creeps, position) {
        const ranges = creeps.filter(operational).map(function (creep) {
            return get8WayGridRange(position, creep);
        });
        return new PositionStatistics(ranges);
    }
    static forCreepsAndFlag(creeps, flag) {
        if (!exists(flag))
            return new PositionStatistics([]);
        return PositionStatistics.forCreepsAndPosition(creeps, flag);
    }
    toString() {
        return `No [${this.numberOfCreeps}] min/2nd [${this.min}/${this.min2nd}] max [${this.max}] median [${this.median}] canReach [${this.canReach}]`;
    }
}
let myFlag;
let enemyFlag;
let flagDistance;
let enemyAttacked = false;
const unexpecteds = [];
const rushRandom = [];
const rushOrganised = [];
const powerUp = [];
const defence = [];
const defenceOrRushRandom = [];
const defenceOrRushOrganised = [];
const prepare = [];
function handleUnexpectedCreeps(creeps) {
    for (const creep of creeps) {
        console.log('Unexpected creep ', creep);
        if (enemyFlag) {
            unexpecteds.push(new CreepPositionGoal(creep, enemyFlag));
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
    flagDistance = get8WayGridRange(myFlag, enemyFlag);
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
    const defenceGoals = GridCreepPositionGoalBuilder.around(myFlag)
        .setOffsetXY(-3, -3)
        .withCreepToXY(expected[0], 6, 6)
        .withCreepToXY(expected[1], 5, 5)
        .withCreepToXY(expected[2], 6, 4)
        .withCreepToXY(expected[3], 5, 7)
        .withCreepToXY(expected[4], 5, 2)
        .withCreepToXY(expected[5], 3, 5)
        .withCreepToXY(expected[6], 4, 3)
        .withCreepToXY(expected[7], 3, 4)
        .withCreepToXY(expected[8], 4, 4)
        .withCreepToXY(expected[9], 2, 5)
        .withCreepToXY(expected[10], 7, 5)
        .withCreepToXY(expected[11], 4, 6)
        .withCreepToXY(expected[12], 5, 3)
        .withCreepToXY(expected[13], 3, 3) // doorstop
        .autoRotate()
        .build();
    const powerUpAll = new BodyPartGoal();
    for (const defenceGoal of defenceGoals) {
        const rushGoal = new CreepPositionGoal(defenceGoal.creep, enemyFlag);
        defence.push(defenceGoal);
        rushRandom.push(rushGoal);
        defenceOrRushRandom.push(new OrGoal([defenceGoal, rushGoal]));
        powerUpAll.addCreep(defenceGoal.creep);
    }
    powerUp.push(powerUpAll);
    const line1 = [defenceGoals[0], defenceGoals[10], defenceGoals[2]];
    const line2 = [defenceGoals[4], defenceGoals[12]];
    const line3 = [defenceGoals[6], defenceGoals[8]];
    const line4 = [defenceGoals[1], defenceGoals[11], defenceGoals[3]];
    const line5 = [defenceGoals[5], defenceGoals[9], defenceGoals[7]];
    const lines = [line1, line2, line3, line4, line5];
    const powerUpActive = new BodyPartGoal();
    for (const line of lines) {
        const doDefence = new AndGoal(line);
        const doOffence = LinePositionGoal.of(line.map(function (goal) {
            return goal.creep;
        }), enemyFlag);
        rushOrganised.push(doOffence);
        defenceOrRushOrganised.push(new OrGoal([doDefence, doOffence]));
        for (const goal of line) {
            powerUpActive.addCreep(goal.creep);
        }
    }
    prepare.push(powerUpActive);
    // don't forget intentional doorstep
    rushOrganised.push(defenceGoals[13]);
    defenceOrRushOrganised.push(defenceGoals[13]);
    prepare.push(defenceGoals[13]);
    console.log('Planning complete at ' + getCpuTime());
}
function advanceGoals() {
    unexpecteds.forEach(advance);
    if (myFlag === undefined || enemyFlag === undefined)
        return;
    const ticks = getTicks();
    const early = ticks < flagDistance / 2;
    const hot = ticks > TICK_LIMIT - MAP_SIDE_SIZE;
    const endspiel = ticks > TICK_LIMIT - MAP_SIDE_SIZE * 2.5;
    const enemyOffence = PositionStatistics.forCreepsAndFlag(enemyPlayerInfo.creeps, myFlag);
    const enemyDefence = PositionStatistics.forCreepsAndFlag(enemyPlayerInfo.creeps, enemyFlag);
    // wiped / too far away
    if (enemyOffence.canReach === 0) {
        if (hot) {
            console.log('A. rushRandom');
            rushRandom.forEach(advance);
        }
        else if (endspiel) {
            console.log('B. rushOrganised');
            rushOrganised.forEach(advance);
        }
        else {
            console.log('C. powerUp');
            powerUp.forEach(advance);
        }
        return;
    }
    // idle / castled
    if (enemyDefence.max < MAP_SIDE_SIZE_SQRT) {
        if (hot) {
            console.log('D. rushRandom');
            rushRandom.forEach(advance);
        }
        else if (endspiel) {
            console.log('E. rushOrganised');
            rushOrganised.forEach(advance);
        }
        else {
            console.log('F. prepare');
            prepare.forEach(advance);
        }
        return;
    }
    // enemy started moving
    // brace for early impact
    if (early) {
        console.log('G. defence');
        defence.forEach(advance);
        return;
    }
    // more than half enemy creeps are committed to offence
    if (enemyAttacked || enemyOffence.median < flagDistance * 2 / 3) {
        // latching after river crossing
        if (enemyOffence.median < flagDistance / 2) {
            enemyAttacked = true;
        }
        // continue if deep in, otherwise return and help
        if (hot) {
            console.log('H. defenceOrRushRandom');
            defenceOrRushRandom.forEach(advance);
        }
        else {
            console.log('I. defenceOrRushOrganised');
            defenceOrRushOrganised.forEach(advance);
        }
        return;
    }
    // enemy is not committed to attack yet
    console.log('J. prepare');
    prepare.forEach(advance);
}
function play() {
    autoCombat();
    advanceGoals();
}

export { loop };
