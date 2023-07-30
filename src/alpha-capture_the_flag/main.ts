import assignToGrids, { point as CostPoint, metricFunc as CostFunction } from 'grid-assign-js/dist/lap-jv/index'

import { BodyPartType, Creep, CreepAttackResult, CreepHealResult, CreepMoveResult, CreepRangedAttackResult, CreepRangedHealResult, GameObject, OwnedStructure, Position, Structure, StructureTower, CreepRangedMassAttackResult } from 'game/prototypes'
import { OK, ATTACK, HEAL, MOVE, RANGED_ATTACK, RANGED_ATTACK_DISTANCE_RATE, RANGED_ATTACK_POWER, RESOURCE_ENERGY, TOWER_ENERGY_COST, TOWER_FALLOFF, TOWER_FALLOFF_RANGE, TOWER_OPTIMAL_RANGE, TOWER_RANGE, ERR_NO_BODYPART, ERR_TIRED, ERR_INVALID_ARGS, ERR_NOT_IN_RANGE, TOUGH, BODYPART_COST } from 'game/constants'
import { Direction, FindPathOptions, getCpuTime, getDirection, getObjectsByPrototype, getRange, getTicks } from 'game/utils'
import { Color, LineVisualStyle, Visual } from 'game/visual'
import { BodyPart, Flag } from 'arena/season_alpha/capture_the_flag/basic'

// custom demands to navigation
type MoreFindPathOptions = FindPathOptions

// assumption, no constant given
const MAP_SIDE_SIZE : number = 100
const TICK_LIMIT : number = 2000

// derived constants
const MAP_SIDE_SIZE_SQRT : number = Math.round(Math.sqrt(MAP_SIDE_SIZE))

/**
 * Returns buggy but useful distance metric
 * @param a 1st position
 * @param b 2nd position
 */
function get8WayGridRange (a: Position, b: Position) : number {
  return Math.min(Math.abs(a.x - b.x), Math.abs(a.y - b.y))
}

function sortById (a: GameObject, b: GameObject) : number {
  return a.id.toString().localeCompare(b.id.toString())
}

let _flagCache: Flag[]
function allFlags () : Flag[] {
  if (_flagCache === undefined) {
    _flagCache = getObjectsByPrototype(Flag).sort(sortById)
  }
  return _flagCache
}

let _towerCache: StructureTower[]
function allTowers () : StructureTower[] {
  if (_towerCache === undefined) {
    _towerCache = getObjectsByPrototype(StructureTower).sort(sortById)
  }
  return _towerCache
}

let _creepCache: Creep[]
function allCreeps () : Creep[] {
  if (_creepCache === undefined) {
    _creepCache = getObjectsByPrototype(Creep).sort(sortById)
  }
  return _creepCache
}

class PlayerInfo {
  towers: StructureTower[] = []
  creeps: Creep[] = []
}

type Ownable = Flag | OwnedStructure | Creep

function myOwnable (what: Ownable) : boolean {
  return what.my === true
}

function enemyOwnable (what: Ownable) : boolean {
  return what.my === false
}

function fillPlayerInfo (whoFunction: (x: Ownable) => boolean) : PlayerInfo {
  const playerInfo = new PlayerInfo()

  playerInfo.towers = allTowers().filter(whoFunction)
  playerInfo.creeps = allCreeps().filter(whoFunction)

  return playerInfo
}

let myPlayerInfo: PlayerInfo
let enemyPlayerInfo: PlayerInfo

function collectPlayerInfo () : void {
  myPlayerInfo = fillPlayerInfo(myOwnable)
  enemyPlayerInfo = fillPlayerInfo(enemyOwnable)
}

export function loop () : void {
  if (getTicks() === 1) {
    collectPlayerInfo()
    plan()
  }

  play()
}

function exists (something?: GameObject) : boolean {
  if (something === undefined) return false
  if (something.exists === false) return false
  return true
}

function operational (something?: Structure | Creep) : boolean {
  if (!exists(something)) return false
  if (something!.hits && something!.hits <= 0) return false
  return true
}

function hasActiveBodyPart (creep: Creep, type: string) : boolean {
  return creep.body.some(
    function (bodyPart: BodyPartType) : boolean {
      return bodyPart.hits > 0 && bodyPart.type === type
    }
  )
}

function countActiveBodyParts (creep: Creep) : Map<string, number> {
  const result : Map<string, number> = new Map()
  for (const bodyPart of creep.body) {
    if (bodyPart.hits > 0) {
      const now = result.get(bodyPart.type) || 0
      result.set(bodyPart.type, now + 1)
    }
  }

  return result
}

function notMaxHits (creep: Creep) : boolean {
  return creep.hits < creep.hitsMax
}

function atSamePosition (a: Position, b: Position) : boolean {
  return a.x === b.x && a.y === b.y
}

function getDirectionByPosition (from: Position, to: Position) : Direction | undefined {
  if (atSamePosition(from, to)) return undefined

  const dx = to.x - from.x
  const dy = to.y - from.y

  return getDirection(dx, dy)
}

function towerPower (fullAmount: number, range: number) : number {
  if (range <= TOWER_OPTIMAL_RANGE) return fullAmount

  const effectiveRange = Math.min(range, TOWER_FALLOFF_RANGE)
  const effectiveAmount = fullAmount * (1 - TOWER_FALLOFF * (effectiveRange - TOWER_OPTIMAL_RANGE) / (TOWER_FALLOFF_RANGE - TOWER_OPTIMAL_RANGE))

  return Math.floor(effectiveAmount)
}

function creepCost (creep: Creep) : number {
  return creep.body.map(
    function (bodyPart: BodyPartType) : number {
      return BODYPART_COST[bodyPart.type] || 0
    }
  ).reduce((sum, current) => sum + current, 0)
}

class StructureTowerScore {
  creep: Creep
  range: number
  score: number

  constructor (creep: Creep, range: number) {
    this.creep = creep
    this.range = range
    this.score = this.calculateScore()
  }

  private calculateScore () : number {
    if (this.range > TOWER_RANGE) return 0
    const scoreAtOptimal = this.creep.my ? this.calculateScoreMy() : this.calculateScoreEnemy()
    const withFalloff = towerPower(scoreAtOptimal, this.range)
    return Math.round(withFalloff)
  }

  private calculateScoreMy () : number {
    return creepCost(this.creep)
  }

  private calculateScoreEnemy () : number {
    return creepCost(this.creep)
  }
}

function operateTower (tower: StructureTower) : void {
  if (tower.cooldown > 0) return
  if ((tower.store.getUsedCapacity(RESOURCE_ENERGY) || 0) < TOWER_ENERGY_COST) return

  const allCreepsInRange = allCreeps()
    .filter(operational)
    .filter(
      function (creep: Creep) : boolean {
        if (creep.my) return notMaxHits(creep)
        return true
      }
    )
    .map(
      function (creep: Creep) : StructureTowerScore {
        const range = getRange(tower as Position, creep as Position)
        return new StructureTowerScore(creep, range)
      }
    )
    .filter(
      function (target: StructureTowerScore) : boolean {
        if (target.creep.my) {
          return target.range <= TOWER_OPTIMAL_RANGE * 3
        } else {
          return target.range <= TOWER_OPTIMAL_RANGE * 2
        }
      }
    )
    .sort(
      function (a: StructureTowerScore, b: StructureTowerScore) : number {
        return b.score - a.score
      }
    )

  if (allCreepsInRange.length === 0) return

  const target = allCreepsInRange[0].creep

  if (target.my) {
    tower.heal(target)
  } else {
    tower.attack(target)
  }
}

type Attackable = Structure | Creep

class AttackableAndRange {
  attackable: Attackable
  range: number

  constructor (creep: Creep, attackable: Attackable) {
    this.attackable = attackable
    this.range = getRange(creep as Position, attackable as Position)
  }
}

function autoMeleeAttack (creep: Creep, attackables: Attackable[]) : CreepAttackResult {
  const inRange = attackables.map(
    function (target: Attackable) : AttackableAndRange {
      return new AttackableAndRange(creep, target)
    }
  ).filter(
    function (target: AttackableAndRange) : boolean {
      return target.range <= 1
    }
  )

  if (inRange.length === 0) return ERR_NOT_IN_RANGE

  const target = inRange[0].attackable
  new Visual().line(creep as Position, target as Position, { color: '#f93842' as Color } as LineVisualStyle)
  return creep.attack(target)
}

function rangedMassAttackPower (target: AttackableAndRange) : number {
  return RANGED_ATTACK_POWER * (RANGED_ATTACK_DISTANCE_RATE[target.range] || 0)
}

function autoRangedAttack (creep: Creep, attackables: Attackable[]) : CreepRangedAttackResult | CreepRangedMassAttackResult {
  const inRange = attackables.map(
    function (target: Attackable) : AttackableAndRange {
      return new AttackableAndRange(creep, target)
    }
  ).filter(
    function (target: AttackableAndRange) : boolean {
      return target.range <= 3
    }
  )

  if (inRange.length === 0) return ERR_NOT_IN_RANGE

  const totalMassAttackPower = inRange.map(rangedMassAttackPower).reduce((sum, current) => sum + current, 0)

  if (totalMassAttackPower >= RANGED_ATTACK_POWER) {
    return creep.rangedMassAttack()
  } else {
    const target = inRange[0].attackable
    return creep.rangedAttack(target)
  }
}

function autoSelfHeal (creep: Creep) : CreepHealResult {
  if (notMaxHits(creep)) return creep.heal(creep)
  return ERR_NOT_IN_RANGE
}

function autoMeleeHeal (creep: Creep, healables: Creep[]) : CreepHealResult {
  const inRange = healables.map(
    function (target: Creep) : AttackableAndRange {
      return new AttackableAndRange(creep, target)
    }
  ).filter(
    function (target: AttackableAndRange) : boolean {
      // voluntary, self heal handled elsewhere
      return target.range <= 1 && target.attackable.id !== creep.id
    }
  )

  if (inRange.length === 0) return ERR_NOT_IN_RANGE

  const target = inRange[0].attackable as Creep
  new Visual().line(creep as Position, target as Position, { color: '#65fd62' as Color } as LineVisualStyle)
  return creep.heal(target)
}

function autoRangedHeal (creep: Creep, healables: Creep[]) : CreepRangedHealResult {
  const inRange = healables.map(
    function (target: Creep) : AttackableAndRange {
      return new AttackableAndRange(creep, target)
    }
  ).filter(
    function (target: AttackableAndRange) : boolean {
      // mandatory, ranged does not work on self
      return target.range <= 3 && target.attackable.id !== creep.id
    }
  )

  if (inRange.length === 0) return ERR_NOT_IN_RANGE

  const target = inRange[0].attackable as Creep
  return creep.rangedHeal(target)
}

function autoAll (creep: Creep, attackables: Attackable[], healables: Creep[]) {
  // https://docs.screeps.com/simultaneous-actions.html
  const counts = countActiveBodyParts(creep)

  const tough : number = counts.get(TOUGH) || 0
  const melee : number = counts.get(ATTACK) || 0
  const ranged : number = counts.get(RANGED_ATTACK) || 0
  const heal : number = counts.get(HEAL) || 0

  // solve simple cases

  if (melee === 0 && ranged === 0 && heal === 0) return

  if (melee > 0 && ranged === 0 && heal === 0) {
    autoMeleeAttack(creep, attackables)
    return
  }

  if (melee === 0 && ranged > 0 && heal === 0) {
    autoRangedAttack(creep, attackables)
    return
  }

  if (melee === 0 && ranged === 0 && heal > 0) {
    if (autoSelfHeal(creep) === OK) return
    if (autoMeleeHeal(creep, healables) === OK) return
    autoRangedHeal(creep, healables)
    return
  }

  if (heal === 0) {
    autoMeleeAttack(creep, attackables)
    autoRangedAttack(creep, attackables)
    return
  }

  // solve medium cases

  const asHealAsPossible = function () : void {
    if (autoSelfHeal(creep) === OK) {
      autoRangedAttack(creep, attackables)
      return
    }

    if (autoMeleeHeal(creep, healables) === OK) {
      autoRangedAttack(creep, attackables)
      return
    }

    if (ranged > heal) {
      if (autoRangedAttack(creep, attackables) === OK) return
      autoRangedHeal(creep, healables)
    } else {
      if (autoRangedHeal(creep, healables) === OK) return
      autoRangedAttack(creep, attackables)
    }
  }

  if (melee === 0) {
    asHealAsPossible()
    return
  }

  // solve complex cases

  const meleeThenHeal = function () : void {
    if (autoMeleeAttack(creep, attackables) === OK) {
      autoRangedAttack(creep, attackables)
      return
    }

    asHealAsPossible()
  }

  if (tough > 0) {
    meleeThenHeal()
    return
  }

  if (melee > heal) {
    meleeThenHeal()
    return
  }

  if (autoSelfHeal(creep) === OK) {
    autoRangedAttack(creep, attackables)
    return
  }

  if (autoMeleeHeal(creep, healables) === OK) {
    autoRangedAttack(creep, attackables)
    return
  }

  if (heal >= ranged) {
    if (autoRangedHeal(creep, healables) === OK) return
  }

  if (autoRangedAttack(creep, attackables) === OK) {
    autoMeleeAttack(creep, attackables)
  }

  if (autoRangedHeal(creep, healables) === OK) return

  autoMeleeAttack(creep, attackables)
}

function autoCombat () {
  myPlayerInfo.towers.filter(operational).forEach(operateTower)

  // attacking towers is possible, but not practical
  // const enemyCreeps = enemyPlayerInfo.creeps.filter(operational)
  // const enemyTowers = enemyPlayerInfo.towers.filter(operational)
  // const enemyAttackables = (enemyCreeps as Attackable[]).concat(enemyTowers as Attackable[])

  // attack only enemy creeps
  const enemyAttackables = enemyPlayerInfo.creeps.filter(operational).sort(
    function (a: Creep, b: Creep) : number {
      return creepCost(b) - creepCost(a)
    }
  )

  const myCreeps = myPlayerInfo.creeps.filter(operational)
  const myHealableCreeps = myCreeps.filter(notMaxHits).sort(
    function (a: Creep, b: Creep) : number {
      return creepCost(b) - creepCost(a)
    }
  )

  myCreeps.forEach(
    function (creep) : void {
      autoAll(creep, enemyAttackables, myHealableCreeps)
    }
  )
}

class CreepLine {
  creeps: Creep[]

  // head at index 0
  constructor (creeps: Creep[]) {
    // safeguard against array modifications
    this.creeps = creeps.concat()
  }

  move (direction: Direction, options?: MoreFindPathOptions) : CreepMoveResult {
    const [rc, loco] = this.chaseLoco(options)
    if (rc !== OK) return rc

    return loco!.move(direction)
  }

  moveTo (target: Position, options?: MoreFindPathOptions) {
    const [rc, loco] = this.chaseLoco(options)
    if (rc !== OK) return rc

    if (atSamePosition(loco! as Position, target)) return OK

    return loco!.moveTo(target, options)
  }

  protected locoToWagonIndex (magicNumber: number, options?: MoreFindPathOptions) : number {
    return magicNumber
  }

  protected wagonToLocoIndex (magicNumber: number, options?: MoreFindPathOptions) : number {
    return this.creeps.length - 1 - magicNumber
  }

  valid () {
    return this.creeps.some(operational)
  }

  cost (target: Position, options?: MoreFindPathOptions) {
    for (let i = 0; i < this.creeps.length; ++i) {
      const ri = this.locoToWagonIndex(i, options)
      const loco = this.creeps[ri]
      if (operational(loco)) {
        return get8WayGridRange(loco as Position, target)
      }
    }

    return Number.MAX_SAFE_INTEGER
  }

  private chaseLoco (options?: MoreFindPathOptions) : [CreepMoveResult, Creep?] {
    const state = this.refreshState()
    if (state !== OK) return [state, undefined]

    // all !operational creeps are removed
    // all creeps can move

    // simple case
    if (this.creeps.length === 1) return [OK, this.creeps[0]]

    for (let i = 0; i < this.creeps.length - 1; ++i) {
      const ri0 = this.wagonToLocoIndex(i, options)
      const ri1 = this.wagonToLocoIndex(i + 1, options)

      const current = this.creeps[ri0]
      const next = this.creeps[ri1]

      const range = getRange(current as Position, next as Position)

      if (range === 1) {
        // just a step
        const direction = getDirectionByPosition(current as Position, next as Position)
        current.move(direction!) // because range 1 should work
      } else if (range > 1) {
        current.moveTo(next as Position, options)
        // give time to catch up
        return [ERR_TIRED, undefined]
      } else {
        // just to cover the case
        return [ERR_INVALID_ARGS, undefined]
      }
    }

    // return head for command
    const locoIndex = this.locoToWagonIndex(0, options)
    return [OK, this.creeps[locoIndex]]
  }

  private refreshState () : CreepMoveResult {
    this.creeps = this.creeps.filter(operational)

    if (this.creeps.length === 0) return ERR_NO_BODYPART

    for (const creep of this.creeps) {
      if (creep.fatigue > 0) return ERR_TIRED
      if (!hasActiveBodyPart(creep, MOVE)) return ERR_NO_BODYPART
    }

    return OK
  }
}

class Rotator {
  protected anchor: Position
  protected offset: Position
  protected positions: Position[]

  protected constructor (anchor: Position) {
    this.anchor = anchor
    this.offset = { x: 0, y: 0 } as Position
    this.positions = []
  }

  protected setOffset (offset: Position) {
    this.offset = offset
  }

  protected with (position: Position) {
    const shifted = { x: position.x + this.offset.x, y: position.y + this.offset.y }
    this.positions.push(shifted)
  }

  protected rotate0 () {
  }

  protected rotate90 () {
    this.rotateImpl(0, -1, 1, 0)
  }

  protected rotate180 () {
    this.rotateImpl(-1, 0, 0, -1)
  }

  protected rotate270 () {
    this.rotateImpl(0, 1, -1, 0)
  }

  // . x ------>
  // y 0    90
  // | 270 180
  // v
  protected autoRotate () {
    const half = Math.round(MAP_SIDE_SIZE / 2)

    if (this.anchor.x < half) {
      if (this.anchor.y < half) {
        this.rotate0()
      } else {
        this.rotate270()
      }
    } else {
      if (this.anchor.y < half) {
        this.rotate90()
      } else {
        this.rotate180()
      }
    }
  }

  private rotateImpl (x2x: number, y2x: number, x2y: number, y2y: number) {
    for (const position of this.positions) {
      const x = position.x * x2x + position.y * y2x
      const y = position.x * x2y + position.y * y2y
      // for whatever weirdness that may follow
      position.x = Math.round(x)
      position.y = Math.round(y)
    }
  }

  protected build () {
    for (const position of this.positions) {
      const x = this.anchor.x + position.x
      const y = this.anchor.y + position.y
      position.x = x
      position.y = y
    }
  }
}

interface Goal {
  advance (options?: MoreFindPathOptions) : CreepMoveResult
  valid () : boolean
  cost (options?: MoreFindPathOptions) : number
}

function advance (positionGoal: Goal) : void {
  positionGoal.advance()
}

class CreepPositionGoal implements Goal {
  creep: Creep
  position: Position

  constructor (creep: Creep, position: Position) {
    this.creep = creep
    this.position = position
  }

  advance (options?: MoreFindPathOptions): CreepMoveResult {
    if (!operational(this.creep)) return ERR_NO_BODYPART
    if (atSamePosition(this.creep as Position, this.position)) return OK
    return this.creep.moveTo(this.position, options)
  }

  valid (): boolean {
    return operational(this.creep)
  }

  cost (options?: MoreFindPathOptions): number {
    return get8WayGridRange(this.creep as Position, this.position)
  }
}

class GridCreepPositionGoalBuilder extends Rotator {
  creeps: Creep[]

  private constructor (anchor: Position) {
    super(anchor)
    this.creeps = []
  }

  static around (position: Position) : GridCreepPositionGoalBuilder {
    return new GridCreepPositionGoalBuilder(position)
  }

  public setOffset (offset: Position): GridCreepPositionGoalBuilder {
    super.setOffset(offset)
    return this
  }

  public setOffsetXY (x: number, y: number) : GridCreepPositionGoalBuilder {
    const position = { x, y } as Position
    super.setOffset(position)
    return this
  }

  public withCreepToPosition (creep: Creep, position: Position) : GridCreepPositionGoalBuilder {
    this.creeps.push(creep)
    super.with(position)
    return this
  }

  public withCreepToXY (creep: Creep, x: number, y: number) : GridCreepPositionGoalBuilder {
    const position = { x, y } as Position
    return this.withCreepToPosition(creep, position)
  }

  public rotate0 (): GridCreepPositionGoalBuilder {
    super.rotate0()
    return this
  }

  public rotate90 (): GridCreepPositionGoalBuilder {
    super.rotate90()
    return this
  }

  public rotate180 (): GridCreepPositionGoalBuilder {
    super.rotate180()
    return this
  }

  public rotate270 (): GridCreepPositionGoalBuilder {
    super.rotate270()
    return this
  }

  public autoRotate (): GridCreepPositionGoalBuilder {
    super.autoRotate()
    return this
  }

  public build () : CreepPositionGoal[] {
    super.build()
    if (this.creeps.length !== this.positions.length) return []

    const result : CreepPositionGoal[] = new Array(this.creeps.length)
    for (let i = 0; i < this.creeps.length; ++i) {
      result[i] = new CreepPositionGoal(this.creeps[i], this.positions[i])
    }

    return result
  }
}

class LinePositionGoal implements Goal {
  creepLine: CreepLine
  position: Position

  protected constructor (creepLine: CreepLine, position: Position) {
    this.creepLine = creepLine
    this.position = position
  }

  static of (creeps: Creep[], position: Position) : LinePositionGoal {
    const creepLine = new CreepLine(creeps)
    return new LinePositionGoal(creepLine, position)
  }

  advance (options?: MoreFindPathOptions): CreepMoveResult {
    return this.creepLine.moveTo(this.position, options)
  }

  valid (): boolean {
    return this.creepLine.valid()
  }

  cost (options?: MoreFindPathOptions): number {
    return this.creepLine.cost(this.position, options)
  }
}

class BodyPartGoal implements Goal {
  creeps: Creep[]

  constructor () {
    this.creeps = []
  }

  addCreep (creep: Creep) {
    this.creeps.push(creep)
  }

  advance (options?: MoreFindPathOptions): CreepMoveResult {
    const allBodyPards = getObjectsByPrototype(BodyPart)
    if (allBodyPards.length === 0) return OK

    const bodyPartsOfType = function (type: string) : BodyPart[] {
      return allBodyPards.filter(
        function (bodyPart: BodyPart) : boolean {
          return bodyPart.type === type
        }
      )
    }

    this.creeps = this.creeps.filter(operational)
    if (this.creeps.length === 0) return ERR_NO_BODYPART

    const notEnoughMove = function (creep: Creep) : boolean {
      let balance = 0
      for (const bodyPart of creep.body) {
        if (bodyPart.type === MOVE) ++balance
        else --balance
      }
      return balance < 0
    }

    const allCreeps = this.creeps
    const creepsWithNotEnoughMove = allCreeps.filter(notEnoughMove)

    const creepsWithBodyPart = function (type: string) : Creep[] {
      return allCreeps.filter(
        function (creep: Creep) : boolean {
          return creep.body.some(
            function (bodyPart: BodyPartType) : boolean {
              return bodyPart.type === type
            }
          )
        }
      )
    }

    const goals : Map<string, CreepPositionGoal> = new Map()

    const addToGoalsPerCreep = function (goal: CreepPositionGoal) : void {
      goals.set(goal.creep.id.toLocaleString(), goal)
    }

    BodyPartGoal.goalsForGroup(
      allCreeps,
      bodyPartsOfType(TOUGH)
    ).forEach(addToGoalsPerCreep)

    BodyPartGoal.goalsForGroup(
      allCreeps,
      bodyPartsOfType(MOVE)
    ).forEach(addToGoalsPerCreep)

    BodyPartGoal.goalsForGroup(
      creepsWithBodyPart(ATTACK),
      bodyPartsOfType(ATTACK)
    ).forEach(addToGoalsPerCreep)

    BodyPartGoal.goalsForGroup(
      creepsWithBodyPart(RANGED_ATTACK),
      bodyPartsOfType(RANGED_ATTACK)
    ).forEach(addToGoalsPerCreep)

    BodyPartGoal.goalsForGroup(
      creepsWithBodyPart(HEAL),
      bodyPartsOfType(HEAL)
    ).forEach(addToGoalsPerCreep)

    BodyPartGoal.goalsForGroup(
      creepsWithNotEnoughMove,
      bodyPartsOfType(MOVE)
    ).forEach(addToGoalsPerCreep)

    let totalRc : CreepMoveResult = OK
    for (const goal of goals.values()) {
      const rc = goal.advance(options)
      if (rc < totalRc) totalRc = rc
    }

    return totalRc
  }

  private static goalsForGroup (creeps: Creep[], bodyParts: BodyPart[]) : CreepPositionGoal[] {
    if (bodyParts.length === 0) return []
    if (creeps.length === 0) return []

    let expandedBodyParts = bodyParts
    while (expandedBodyParts.length < creeps.length) {
      expandedBodyParts = expandedBodyParts.concat(bodyParts)
    }

    const actors : CostPoint[] = []
    for (let i = 0; i < creeps.length; ++i) {
      const creep = creeps[i]
      actors.push([creep.x, creep.y, -creep.fatigue])
    }

    const targetPoints : CostPoint[] = []
    for (let i = 0; i < expandedBodyParts.length; ++i) {
      const bodyPart = expandedBodyParts[i]
      targetPoints.push([bodyPart.x, bodyPart.y, bodyPart.ticksToDecay])
    }

    const COST_NO_ASSIGN = 100000
    const distanceMetric : CostFunction = function (actor: CostPoint, targetPoint: CostPoint) : number {
      const dx = Math.abs(actor[0] - targetPoint[0])
      const dy = Math.abs(actor[1] - targetPoint[1])
      const dt = Math.abs(actor[2] - targetPoint[2])

      const flatRange = Math.max(dx, dy)

      // with some extra time for swamp and corners
      if (flatRange > dt - MAP_SIDE_SIZE_SQRT) return COST_NO_ASSIGN

      return flatRange
    }

    const assignments = assignToGrids({
      assignTo: actors,
      points: targetPoints,
      distanceMetric
    })

    const result : CreepPositionGoal[] = []

    for (let actorIndex = 0; actorIndex < assignments.length; ++actorIndex) {
      const targetIndex = assignments[actorIndex]

      // since there is no cost returned, do manual extra check
      const actor = actors[actorIndex]
      const targetPoint = targetPoints[targetIndex]
      const cost = distanceMetric(actor, targetPoint)
      if (cost >= COST_NO_ASSIGN) continue

      const creep = creeps[actorIndex]
      const bodyPart = expandedBodyParts[targetIndex]

      const goal = new CreepPositionGoal(creep, bodyPart as Position)
      result.push(goal)
    }

    return result
  }

  valid (): boolean {
    return this.creeps.some(operational)
  }

  cost (options?: MoreFindPathOptions): number {
    // too fractal to calculate
    return MAP_SIDE_SIZE / 2
  }
}

class OneOrMoreGoal implements Goal {
  goals: Goal[]

  constructor (goals: Goal[]) {
    this.goals = goals
  }

  advance (options?: MoreFindPathOptions): CreepMoveResult {
    if (this.goals.length === 0) return ERR_INVALID_ARGS

    let hasValid = false
    let resultRc : CreepMoveResult = OK

    for (const goal of this.goals) {
      if (!goal.valid()) continue

      hasValid = true

      const rc = goal.advance(options)
      if (rc < resultRc) resultRc = rc
    }

    return hasValid ? resultRc : ERR_NO_BODYPART
  }

  valid (): boolean {
    return this.goals.some(x => x.valid())
  }

  cost (options?: MoreFindPathOptions): number {
    if (this.goals.length === 0) return Number.MAX_SAFE_INTEGER

    let hasValid = false
    let maxCost = Number.MIN_SAFE_INTEGER

    for (const goal of this.goals) {
      if (!goal.valid()) continue

      hasValid = true

      const cost = goal.cost(options)
      if (cost > maxCost) maxCost = cost
    }

    return hasValid ? maxCost : Number.MAX_SAFE_INTEGER
  }
}

class OrGoal implements Goal {
  goals: Goal[]

  constructor (goals: Goal[]) {
    this.goals = goals
  }

  advance (options?: MoreFindPathOptions): CreepMoveResult {
    if (this.goals.length === 0) return ERR_INVALID_ARGS

    let minIndex = -1
    let minCost = Number.MAX_SAFE_INTEGER

    for (let i = 0; i < this.goals.length; ++i) {
      const goal = this.goals[i]

      if (!goal.valid()) continue

      const goalCost = goal.cost(options)
      if (goalCost < minCost) {
        minIndex = i
        minCost = goalCost
      }
    }

    if (minIndex < 0) return ERR_NO_BODYPART
    return this.goals[minIndex].advance(options)
  }

  valid (): boolean {
    return this.goals.some(x => x.valid())
  }

  cost (options?: MoreFindPathOptions): number {
    if (this.goals.length === 0) return Number.MAX_SAFE_INTEGER

    let minCost = Number.MAX_SAFE_INTEGER

    for (const goal of this.goals) {
      if (!goal.valid()) continue

      const cost = goal.cost(options)
      if (cost < minCost) minCost = cost
    }

    return minCost
  }
}

class CreepFilter {
  bodyTypes: string[]
  positions: Position[]

  constructor (bodyTypes: string[], positions: Position[]) {
    this.bodyTypes = bodyTypes
    this.positions = positions
  }

  // returns [found creeps in specified order, remainder]
  // uses all or nothing approach, if one requested is not found, all are dropped
  filter (creeps: Creep[]) : [Creep[], Creep[]] {
    if (this.positions.length !== this.bodyTypes.length) return [[], creeps]

    const found : Creep[] = new Array(this.positions.length)
    const remainder : Creep[] = []

    for (const creep of creeps) {
      let positionNotFound = true

      for (let i = 0; i < this.positions.length && positionNotFound; ++i) {
        const position = this.positions[i]
        if (atSamePosition(creep as Position, position)) {
          if (hasActiveBodyPart(creep, this.bodyTypes[i])) {
            found[i] = creep
            positionNotFound = false
          } else {
            return [[], creeps]
          }
        }
      }

      if (positionNotFound) remainder.push(creep)
    }

    for (const x of found) {
      if (x === undefined) return [[], creeps]
    }

    return [found, remainder]
  }
}

class CreepFilterBuilder extends Rotator {
  bodyTypes: string[]

  private constructor (anchor: Position) {
    super(anchor)
    this.bodyTypes = []
  }

  static around (position: Position) : CreepFilterBuilder {
    return new CreepFilterBuilder(position)
  }

  public setOffset (offset: Position): CreepFilterBuilder {
    super.setOffset(offset)
    return this
  }

  public setOffsetXY (x: number, y: number) {
    const position = { x, y } as Position
    return this.setOffset(position)
  }

  public withBodyTypeAtPosition (bodyType: string, position: Position) : CreepFilterBuilder {
    this.bodyTypes.push(bodyType)
    super.with(position)
    return this
  }

  public withBodyTypeAtXY (bodyType: string, x: number, y: number) : CreepFilterBuilder {
    const position = { x, y } as Position
    return this.withBodyTypeAtPosition(bodyType, position)
  }

  public rotate0 (): CreepFilterBuilder {
    super.rotate0()
    return this
  }

  public rotate90 (): CreepFilterBuilder {
    super.rotate90()
    return this
  }

  public rotate180 (): CreepFilterBuilder {
    super.rotate180()
    return this
  }

  public rotate270 (): CreepFilterBuilder {
    super.rotate270()
    return this
  }

  public autoRotate (): CreepFilterBuilder {
    super.autoRotate()
    return this
  }

  public build (): CreepFilter {
    super.build()
    return new CreepFilter(this.bodyTypes, this.positions)
  }
}

class PositionStatistics {
  numberOfCreeps: number

  min: number
  min2nd: number
  max: number
  median: number

  canReach: number

  private constructor (ranges: number[]) {
    this.numberOfCreeps = ranges.length
    this.min = Number.MAX_SAFE_INTEGER
    this.min2nd = Number.MAX_SAFE_INTEGER
    this.max = Number.MIN_SAFE_INTEGER
    this.median = NaN
    this.canReach = 0

    if (this.numberOfCreeps === 0) return

    const sorted = ranges.sort()

    this.min = sorted[0]
    this.min2nd = sorted.length > 1 ? sorted[1] : sorted[0]
    this.max = sorted[sorted.length - 1]
    this.median = sorted[Math.floor(sorted.length / 2)]

    const ticksRemaining = TICK_LIMIT - getTicks()

    if (sorted[0] > ticksRemaining) {
      this.canReach = 0
    } else if (sorted[sorted.length - 1] <= ticksRemaining) {
      this.canReach = sorted.length
    } else {
      this.canReach = sorted.findIndex(
        function (range: number) : boolean {
          return range > ticksRemaining
        }
      )
    }
  }

  static forCreepsAndPosition (creeps: Creep[], position: Position) : PositionStatistics {
    const ranges = creeps.filter(operational).map(
      function (creep: Creep) : number {
        return get8WayGridRange(position, creep as Position)
      }
    )

    return new PositionStatistics(ranges)
  }

  static forCreepsAndFlag (creeps: Creep[], flag?: Flag) : PositionStatistics {
    if (!exists(flag)) return new PositionStatistics([])

    return PositionStatistics.forCreepsAndPosition(creeps, flag! as Position)
  }

  toString () : string {
    return `No [${this.numberOfCreeps}] min/2nd [${this.min}/${this.min2nd}] max [${this.max}] median [${this.median}] canReach [${this.canReach}]`
  }
}

let myFlag : Flag | undefined
let enemyFlag : Flag | undefined

let flagDistance : number
let enemyAttacked : boolean = false

const unexpecteds : Goal[] = []
const rushRandom : Goal[] = []
const rushOrganised : Goal[] = []
const powerUp : Goal[] = []
const defence : Goal[] = []
const defenceOrRushRandom : Goal[] = []
const defenceOrRushOrganised : Goal [] = []
const prepare : Goal[] = []

function handleUnexpectedCreeps (creeps: Creep[]) : void {
  for (const creep of creeps) {
    console.log('Unexpected creep ', creep)
    if (enemyFlag) {
      unexpecteds.push(new CreepPositionGoal(creep, enemyFlag as Position))
    }
  }
}

function plan () : void {
  myFlag = allFlags().find(myOwnable)
  if (myFlag === undefined) {
    console.log('myFlag not found')
    handleUnexpectedCreeps(myPlayerInfo.creeps)
    return
  }

  enemyFlag = allFlags().find(enemyOwnable)
  if (enemyFlag === undefined) {
    console.log('enemyFlag not found')
    handleUnexpectedCreeps(myPlayerInfo.creeps)
    return
  }

  flagDistance = get8WayGridRange(myFlag as Position, enemyFlag as Position)

  // check if all expected creeps are in place
  const myCreepsFilter = CreepFilterBuilder.around(myFlag as Position)
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
    .build()

  const [expected, unexpected] = myCreepsFilter.filter(myPlayerInfo.creeps)
  if (expected.length === 0) {
    console.log('Creeps are not on expected positions')
    handleUnexpectedCreeps(myPlayerInfo.creeps)
    return
  }

  if (unexpected.length > 0) {
    console.log('Unexpected creeps detected')
    handleUnexpectedCreeps(unexpected)
  }

  const defenceGoals = GridCreepPositionGoalBuilder.around(myFlag as Position)
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
    .build()

  const powerUpAll = new BodyPartGoal()
  for (const defenceGoal of defenceGoals) {
    const rushGoal = new CreepPositionGoal(defenceGoal.creep, enemyFlag as Position)

    defence.push(defenceGoal)
    rushRandom.push(rushGoal)
    defenceOrRushRandom.push(new OrGoal([defenceGoal, rushGoal]))

    powerUpAll.addCreep(defenceGoal.creep)
  }
  powerUp.push(powerUpAll)

  const line1 : CreepPositionGoal[] = [defenceGoals[0], defenceGoals[10], defenceGoals[2]]
  const line2 : CreepPositionGoal[] = [defenceGoals[4], defenceGoals[12]]
  const line3 : CreepPositionGoal[] = [defenceGoals[6], defenceGoals[8]]
  const line4 : CreepPositionGoal[] = [defenceGoals[1], defenceGoals[11], defenceGoals[3]]
  const line5 : CreepPositionGoal[] = [defenceGoals[5], defenceGoals[9], defenceGoals[7]]
  const lines : CreepPositionGoal[][] = [line1, line2, line3, line4, line5]

  const powerUpActive = new BodyPartGoal()
  for (const line of lines) {
    const doDefence = new OneOrMoreGoal(line)
    const doOffence = LinePositionGoal.of(line.map(
      function (goal: CreepPositionGoal) : Creep {
        return goal.creep
      }
    ), enemyFlag as Position)

    rushOrganised.push(doOffence)
    defenceOrRushOrganised.push(new OrGoal([doDefence, doOffence]))

    for (const goal of line) {
      powerUpActive.addCreep(goal.creep)
    }
  }
  prepare.push(powerUpActive)

  // don't forget intentional doorstep
  rushOrganised.push(defenceGoals[13])
  defenceOrRushOrganised.push(defenceGoals[13])
  prepare.push(defenceGoals[13])

  console.log('Planning complete at ' + getCpuTime())
}

function advanceGoals () : void {
  unexpecteds.forEach(advance)

  if (myFlag === undefined || enemyFlag === undefined) return

  const ticks = getTicks()

  const early = ticks < flagDistance / 2
  const hot = ticks > TICK_LIMIT - MAP_SIDE_SIZE
  const endspiel = ticks > TICK_LIMIT - MAP_SIDE_SIZE * 2.5

  const enemyOffence = PositionStatistics.forCreepsAndFlag(enemyPlayerInfo.creeps, myFlag)
  const enemyDefence = PositionStatistics.forCreepsAndFlag(enemyPlayerInfo.creeps, enemyFlag)

  // wiped / too far away
  if (enemyOffence.canReach === 0) {
    if (hot) {
      console.log('A. rushRandom')
      rushRandom.forEach(advance)
    } else if (endspiel) {
      console.log('B. rushOrganised')
      rushOrganised.forEach(advance)
    } else {
      console.log('C. powerUp')
      powerUp.forEach(advance)
    }

    return
  }

  // idle / castled
  if (enemyDefence.max < MAP_SIDE_SIZE_SQRT) {
    if (hot) {
      console.log('D. rushRandom')
      rushRandom.forEach(advance)
    } else if (endspiel) {
      console.log('E. rushOrganised')
      rushOrganised.forEach(advance)
    } else {
      console.log('F. prepare')
      prepare.forEach(advance)
    }

    return
  }

  // enemy started moving

  // brace for early impact
  if (early) {
    console.log('G. defence')
    defence.forEach(advance)

    return
  }

  // more than half enemy creeps are committed to offence
  if (enemyAttacked || enemyOffence.median < flagDistance * 2 / 3) {
    // latching after river crossing
    if (enemyOffence.median < flagDistance / 2) {
      enemyAttacked = true
    }

    // continue if deep in, otherwise return and help
    if (hot) {
      console.log('H. defenceOrRushRandom')
      defenceOrRushRandom.forEach(advance)
    } else {
      console.log('I. defenceOrRushOrganised')
      defenceOrRushOrganised.forEach(advance)
    }

    return
  }

  // enemy is not committed to attack yet
  console.log('J. prepare')
  prepare.forEach(advance)
}

function play () : void {
  autoCombat()
  advanceGoals()
}
