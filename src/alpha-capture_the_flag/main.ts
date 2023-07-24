import { Creep, CreepMoveResult, GameObject, OwnedStructure, Position, Structure, StructureTower } from 'game/prototypes'
import { OK, ATTACK, HEAL, MOVE, RANGED_ATTACK, RANGED_ATTACK_DISTANCE_RATE, RANGED_ATTACK_POWER, RESOURCE_ENERGY, TOWER_ENERGY_COST, TOWER_FALLOFF, TOWER_FALLOFF_RANGE, TOWER_OPTIMAL_RANGE, TOWER_RANGE, ERR_NO_BODYPART, ERR_TIRED, ERR_INVALID_ARGS } from 'game/constants'
import { Direction, FindPathOptions, getCpuTime, getDirection, getObjectsByPrototype, getRange, getTicks } from 'game/utils'
import { Visual } from 'game/visual'
import { Flag } from 'arena/season_alpha/capture_the_flag/basic'

// assumption, no constant given
const MAP_SIDE_SIZE : number = 100
const TICK_LIMIT : number = 2000

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
    function (bodyPart) : boolean {
      return bodyPart.hits > 0 && bodyPart.type === type
    }
  )
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
    // speed up process
    if (this.range > TOWER_RANGE) return 0
    return this.creep.my ? this.calculateScoreMy() : this.calculateScoreEnemy()
  }

  private calculateScoreMy () : number {
    const hitsLost = this.creep.hitsMax - this.creep.hits
    const percent = hitsLost / this.creep.hitsMax * 100
    const withFalloff = towerPower(percent, this.range)

    return Math.round(withFalloff)
  }

  private calculateScoreEnemy () : number {
    let bodyCost = 0
    for (const bodyPart of this.creep.body) {
      if (bodyPart.hits <= 0) continue

      // default pair of X + MOVE is 10 in sum
      // ignore mutants for simplicity
      if (bodyPart.type === ATTACK || bodyPart.type === HEAL) bodyCost += 6
      else bodyCost += 4
    }

    // again ignore mutants for simplicity
    const maxBodyCost = this.creep.body.length * 5
    const percent = bodyCost / maxBodyCost * 100
    const withFalloff = towerPower(percent, this.range)

    return Math.round(withFalloff)
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

function autoMelee (creep: Creep, attackables: Attackable[]) {
  if (!hasActiveBodyPart(creep, ATTACK)) return

  const inRange = attackables.map(
    function (target: Attackable) : AttackableAndRange {
      return new AttackableAndRange(creep, target)
    }
  ).filter(
    function (target: AttackableAndRange) : boolean {
      return target.range <= 1
    }
  )

  if (inRange.length === 0) return

  const target = inRange[0].attackable
  creep.attack(target)
  new Visual().line(creep as Position, target as Position)
}

function rangedMassAttackPower (target: AttackableAndRange) : number {
  return RANGED_ATTACK_POWER * (RANGED_ATTACK_DISTANCE_RATE[target.range] || 0)
}

function autoRanged (creep: Creep, attackables: Attackable[]) {
  if (!hasActiveBodyPart(creep, RANGED_ATTACK)) return

  const inRange = attackables.map(
    function (target: Attackable) : AttackableAndRange {
      return new AttackableAndRange(creep, target)
    }
  ).filter(
    function (target: AttackableAndRange) : boolean {
      return target.range <= 3
    }
  )

  if (inRange.length === 0) return

  const totalMassAttackPower = inRange.map(rangedMassAttackPower).reduce((sum, current) => sum + current, 0)

  if (totalMassAttackPower >= RANGED_ATTACK_POWER) {
    creep.rangedMassAttack()
  } else {
    const target = inRange[0].attackable
    creep.rangedAttack(target)
    new Visual().line(creep as Position, target as Position)
  }
}

function autoHeal (creep: Creep, healables: Creep[]) {
  if (!hasActiveBodyPart(creep, HEAL)) return

  if (notMaxHits(creep)) {
    creep.heal(creep)
    return
  }

  const inRange = healables.map(
    function (target: Creep) : AttackableAndRange {
      return new AttackableAndRange(creep, target)
    }
  ).filter(
    function (target: AttackableAndRange) : boolean {
      return target.range <= 3
    }
  )

  if (inRange.length === 0) return

  const inTouch = inRange.find(
    function (target: AttackableAndRange) : boolean {
      return target.range <= 1
    }
  )

  if (inTouch !== undefined) {
    creep.heal(inTouch.attackable as Creep)
  } else {
    const target = inRange[0].attackable as Creep
    creep.rangedHeal(target)
    new Visual().line(creep as Position, target as Position)
  }
}

function autoAll (creep: Creep, attackables: Attackable[], healables: Creep[]) {
  autoMelee(creep, attackables)
  autoRanged(creep, attackables)
  autoHeal(creep, healables)
}

function autoCombat () {
  myPlayerInfo.towers.filter(operational).forEach(operateTower)

  // attacking towers is possible, but not practical
  // const enemyCreeps = enemyPlayerInfo.creeps.filter(operational)
  // const enemyTowers = enemyPlayerInfo.towers.filter(operational)
  // const enemyAttackables = (enemyCreeps as Attackable[]).concat(enemyTowers as Attackable[])

  // attack only enemy creeps
  const enemyAttackables = enemyPlayerInfo.creeps.filter(operational)

  const myCreeps = myPlayerInfo.creeps.filter(operational)
  const myHealableCreeps = myCreeps.filter(notMaxHits)

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
    this.creeps = creeps

    // because head at index 0
    this.creeps.reverse()
  }

  move (direction: Direction) : CreepMoveResult {
    const [rc, head] = this.chaseHead()
    if (rc !== OK) return rc

    return head!.move(direction)
  }

  moveTo (target: Position, options?: FindPathOptions) {
    const [rc, head] = this.chaseHead(options)
    if (rc !== OK) return rc

    if (atSamePosition(head! as Position, target)) return OK

    return head!.moveTo(target, options)
  }

  private chaseHead (options?: FindPathOptions) : [CreepMoveResult, Creep?] {
    const state = this.refreshState()
    if (state !== OK) return [state, undefined]

    // all !operational creeps are removed
    // all creeps can move

    // simple case
    if (this.creeps.length === 1) return [OK, this.creeps[0]]

    for (let i = 0; i < this.creeps.length - 1; ++i) {
      const current = this.creeps[i]
      const next = this.creeps[i + 1]

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
    return [OK, this.creeps[this.creeps.length - 1]]
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
    this.rotateImpl(-1, 0, -1, 0)
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

interface PositionGoal {
  advance (options?: FindPathOptions) : CreepMoveResult
}

function advance (positionGoal: PositionGoal) : void {
  positionGoal.advance()
}

class SingleCreepPositionGoal implements PositionGoal {
  creep: Creep
  position: Position

  constructor (creep: Creep, position: Position) {
    this.creep = creep
    this.position = position
  }

  advance (options?: FindPathOptions): CreepMoveResult {
    if (!operational(this.creep)) return ERR_NO_BODYPART
    if (atSamePosition(this.creep as Position, this.position)) return OK
    return this.creep.moveTo(this.position, options)
  }
}

class GridPositionGoal implements PositionGoal {
  creeps: Creep[]
  positions: Position[]

  constructor (creeps: Creep[], positions: Position[]) {
    this.creeps = creeps
    this.positions = positions
  }

  advance (options?: FindPathOptions): CreepMoveResult {
    // error case
    if (this.creeps.length !== this.positions.length) return ERR_INVALID_ARGS

    // elimination case
    if (!this.creeps.some(operational)) return ERR_NO_BODYPART

    let totalRc : CreepMoveResult = OK

    for (let i = 0; i < this.creeps.length; ++i) {
      const creep = this.creeps[i]
      const position = this.positions[i]
      const oneRc = this.advanceOne(creep, position, options)
      if (oneRc < totalRc) totalRc = oneRc // less than because error codes are negatives
    }

    return totalRc
  }

  private advanceOne (creep: Creep, position: Position, options?: FindPathOptions) : CreepMoveResult {
    if (!operational(creep)) return OK // fallback for the fallen, overall group is OK
    if (atSamePosition(creep as Position, position)) return OK
    return creep.moveTo(position, options)
  }
}

class GridPositionGoalBuilder extends Rotator {
  creeps: Creep[]

  private constructor (anchor: Position) {
    super(anchor)
    this.creeps = []
  }

  static around (position: Position) : GridPositionGoalBuilder {
    return new GridPositionGoalBuilder(position)
  }

  public setOffset (offset: Position): GridPositionGoalBuilder {
    super.setOffset(offset)
    return this
  }

  public setOffsetXY (x: number, y: number) : GridPositionGoalBuilder {
    const position = { x, y } as Position
    super.setOffset(position)
    return this
  }

  public withCreepToPosition (creep: Creep, position: Position) : GridPositionGoalBuilder {
    this.creeps.push(creep)
    super.with(position)
    return this
  }

  public withCreepToXY (creep: Creep, x: number, y: number) : GridPositionGoalBuilder {
    const position = { x, y } as Position
    return this.withCreepToPosition(creep, position)
  }

  public rotate0 (): GridPositionGoalBuilder {
    super.rotate0()
    return this
  }

  public rotate90 (): GridPositionGoalBuilder {
    super.rotate90()
    return this
  }

  public rotate180 (): GridPositionGoalBuilder {
    super.rotate180()
    return this
  }

  public rotate270 (): GridPositionGoalBuilder {
    super.rotate270()
    return this
  }

  public autoRotate (): GridPositionGoalBuilder {
    super.autoRotate()
    return this
  }

  public build () : GridPositionGoal {
    super.build()
    return new GridPositionGoal(this.creeps, this.positions)
  }
}

class LinePositionGoal implements PositionGoal {
  creepLine: CreepLine
  position: Position

  constructor (creeps: Creep[], position: Position) {
    this.creepLine = new CreepLine(creeps)
    this.position = position
  }

  advance (options?: FindPathOptions): CreepMoveResult {
    return this.creepLine.moveTo(this.position, options)
  }
}

class PositionStatistics {
  numberOfCreeps: number

  min: number
  max: number
  average: number
  median: number

  canReach: number

  private constructor (ranges: number[]) {
    this.numberOfCreeps = ranges.length
    this.min = Number.MAX_SAFE_INTEGER
    this.max = Number.MIN_SAFE_INTEGER
    this.average = NaN
    this.median = NaN
    this.canReach = 0

    if (this.numberOfCreeps === 0) return

    const ticksNow = getTicks()
    const ticksRemaining = TICK_LIMIT - ticksNow

    // for median
    const sorted = ranges.sort()

    let total = 0
    for (const x of sorted) {
      if (x < this.min) this.min = x
      if (x > this.max) this.max = x

      this.canReach += x <= ticksRemaining ? 1 : 0

      total += x
    }

    this.average = total / this.numberOfCreeps
    this.median = sorted[Math.floor(this.numberOfCreeps) / 2]
  }

  static forCreepsAndPosition (creeps: Creep[], position: Position) : PositionStatistics {
    const ranges = creeps.filter(operational).map(
      function (creep: Creep) : number {
        return getRange(position, creep as Position)
      }
    )

    return new PositionStatistics(ranges)
  }

  static forCreepsAndFlag (creeps: Creep[], flag?: Flag) : PositionStatistics {
    if (!exists(flag)) return new PositionStatistics([])

    return PositionStatistics.forCreepsAndPosition(creeps, flag! as Position)
  }

  toString () : string {
    return `No [${this.numberOfCreeps}] min [${this.min}] max [${this.max}] average [${this.average}] median [${this.median}] reach [${this.canReach}] `
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

let myFlag : Flag
let enemyFlag : Flag

let enemyStartDistance : number

const unexpectedCreepsGoals : PositionGoal[] = []
const rushRandomAll : PositionGoal[] = []
const defenceGoals : PositionGoal[] = []
const rushWithTwoLines : PositionGoal[] = []
const rushRandomWithDoorstep : PositionGoal[] = []

function handleUnexpectedCreeps (creeps: Creep[]) : void {
  for (const creep of creeps) {
    console.log('Unexpected creep ', creep)
    if (enemyFlag) {
      unexpectedCreepsGoals.push(new SingleCreepPositionGoal(creep, enemyFlag as Position))
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

  expected.forEach(
    function (creep: Creep) : void {
      rushRandomAll.push(new SingleCreepPositionGoal(creep, enemyFlag as Position))
    }
  )

  const doorstopFilter = CreepFilterBuilder.around(myFlag as Position)
    .setOffsetXY(-3, -3)
    .withBodyTypeAtXY(HEAL, 8, 1)
    .autoRotate()
    .build()
  const [doorstopCreeps] = doorstopFilter.filter(myPlayerInfo.creeps)
  const doorstep = new SingleCreepPositionGoal(doorstopCreeps[0], myFlag as Position)
  defenceGoals.push(doorstep)
  rushWithTwoLines.push(doorstep)
  rushRandomWithDoorstep.push(doorstep)

  const defenceFilter = CreepFilterBuilder.around(myFlag as Position)
    .setOffsetXY(-3, -3)
    .withBodyTypeAtXY(ATTACK, 8, 7) // 0
    .withBodyTypeAtXY(ATTACK, 7, 8) // 1
    .withBodyTypeAtXY(RANGED_ATTACK, 8, 6) // 2
    .withBodyTypeAtXY(RANGED_ATTACK, 6, 8) // 3
    .withBodyTypeAtXY(RANGED_ATTACK, 8, 5) // 4
    .withBodyTypeAtXY(RANGED_ATTACK, 5, 8) // 5
    .withBodyTypeAtXY(RANGED_ATTACK, 8, 4) // 6
    .withBodyTypeAtXY(RANGED_ATTACK, 4, 8) // 7
    .withBodyTypeAtXY(HEAL, 8, 3) // 8
    .withBodyTypeAtXY(HEAL, 3, 8) // 9
    .withBodyTypeAtXY(HEAL, 8, 2) // 10
    .withBodyTypeAtXY(HEAL, 2, 8) // 11
    // doorstep
    .withBodyTypeAtXY(HEAL, 1, 8) // 12
    .autoRotate()
    .build()
  const [defenceCreeps] = defenceFilter.filter(myPlayerInfo.creeps)
  defenceGoals.push(
    GridPositionGoalBuilder.around(myFlag as Position)
    .setOffsetXY(-3, -3)
    .withCreepToXY(defenceCreeps[0], 3, 3)
    .withCreepToXY(defenceCreeps[1], 3, 3)
    .withCreepToXY(defenceCreeps[2], 3, 3)
    .withCreepToXY(defenceCreeps[3], 3, 3)
    .withCreepToXY(defenceCreeps[4], 3, 3)
    .withCreepToXY(defenceCreeps[5], 3, 3)
    .withCreepToXY(defenceCreeps[6], 3, 3)
    .withCreepToXY(defenceCreeps[7], 3, 3)
    .withCreepToXY(defenceCreeps[8], 3, 3)
    .withCreepToXY(defenceCreeps[9], 3, 3)
    .withCreepToXY(defenceCreeps[10], 3, 3)
    .withCreepToXY(defenceCreeps[11], 3, 3)
    .withCreepToXY(defenceCreeps[12], 3, 3)
    .autoRotate()
    .build()
  )

  const line1Filter = CreepFilterBuilder.around(myFlag as Position)
    .setOffsetXY(-3, -3)
    .withBodyTypeAtXY(ATTACK, 8, 7)
    .withBodyTypeAtXY(HEAL, 8, 3)
    .withBodyTypeAtXY(RANGED_ATTACK, 8, 6)
    .withBodyTypeAtXY(HEAL, 8, 2)
    .withBodyTypeAtXY(RANGED_ATTACK, 8, 5)
    // doorstep
    .withBodyTypeAtXY(RANGED_ATTACK, 8, 4)
    .autoRotate()
    .build()
  const [line1Creeps] = line1Filter.filter(myPlayerInfo.creeps)
  rushWithTwoLines.push(new LinePositionGoal(line1Creeps, enemyFlag as Position))
  line1Creeps.forEach(
    function (creep: Creep) : void {
      rushRandomWithDoorstep.push(new SingleCreepPositionGoal(creep, enemyFlag as Position))
    }
  )

  const line2Filter = CreepFilterBuilder.around(myFlag as Position)
    .setOffsetXY(-3, -3)
    .withBodyTypeAtXY(ATTACK, 7, 8)
    .withBodyTypeAtXY(HEAL, 3, 8)
    .withBodyTypeAtXY(RANGED_ATTACK, 6, 8)
    .withBodyTypeAtXY(HEAL, 2, 8)
    .withBodyTypeAtXY(RANGED_ATTACK, 5, 8)
    .withBodyTypeAtXY(HEAL, 1, 8)
    .withBodyTypeAtXY(RANGED_ATTACK, 4, 8)
    .autoRotate()
    .build()
  const [line2Creeps] = line2Filter.filter(myPlayerInfo.creeps)
  rushWithTwoLines.push(new LinePositionGoal(line2Creeps, enemyFlag as Position))
  line2Creeps.forEach(
    function (creep: Creep) : void {
      rushRandomWithDoorstep.push(new SingleCreepPositionGoal(creep, enemyFlag as Position))
    }
  )

  console.log('Planning complete at ' + getCpuTime())
}

function advanceGoals () : void {
  unexpectedCreepsGoals.forEach(advance)

  if (myFlag === undefined || enemyFlag === undefined) return

  const enemyAdvance = PositionStatistics.forCreepsAndFlag(enemyPlayerInfo.creeps, myFlag)
  if (enemyStartDistance === undefined) {
    enemyStartDistance = enemyAdvance.min
  }

  const endspiel : boolean = getTicks() >= TICK_LIMIT - (MAP_SIDE_SIZE * 2)

  if (enemyAdvance.canReach === 0) {
    if (endspiel) {
      console.log('rushRandomAll')
      rushRandomAll.forEach(advance)
    } else {
      console.log('rushWithTwoLines')
      rushWithTwoLines.forEach(advance)
    }
    return
  }

  const myDefence = PositionStatistics.forCreepsAndFlag(myPlayerInfo.creeps, myFlag)
  if (enemyAdvance.min < enemyStartDistance && enemyAdvance.median <= myDefence.median) {
    console.log('defenceGoals')
    defenceGoals.forEach(advance)
    return
  }

  if (endspiel) {
    console.log('rushRandomWithDoorstep')
    rushRandomWithDoorstep.forEach(advance)
  } else {
    console.log('rushWithTwoLines')
    rushWithTwoLines.forEach(advance)
  }
}

function play () : void {
  advanceGoals()
  autoCombat()
}
