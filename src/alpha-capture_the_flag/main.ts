import { Creep, CreepMoveResult, GameObject, OwnedStructure, Position, Structure, StructureTower } from 'game/prototypes'
import { OK, ATTACK, HEAL, MOVE, RANGED_ATTACK, RANGED_ATTACK_DISTANCE_RATE, RANGED_ATTACK_POWER, RESOURCE_ENERGY, TOWER_ENERGY_COST, TOWER_FALLOFF, TOWER_FALLOFF_RANGE, TOWER_OPTIMAL_RANGE, TOWER_RANGE, ERR_NO_BODYPART, ERR_TIRED, ERR_INVALID_ARGS } from 'game/constants'
import { Direction, FindPathOptions, getDirection, getObjectsByPrototype, getRange, getTicks } from 'game/utils'
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

function fillPlayerInfo (whoFunction: (x: Ownable) => boolean) : PlayerInfo {
  const playerInfo = new PlayerInfo()

  playerInfo.towers = allTowers().filter(whoFunction)
  playerInfo.creeps = allCreeps().filter(whoFunction)

  return playerInfo
}

let myPlayerInfo: PlayerInfo
let enemyPlayerInfo: PlayerInfo

function collectPlayerInfo () : void {
  myPlayerInfo = fillPlayerInfo(
    function my (what: Ownable) : boolean {
      return what.my === true
    }
  )

  enemyPlayerInfo = fillPlayerInfo(
    function enemy (what: Ownable) : boolean {
      return what.my === false
    }
  )
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

  constructor (creeps: Creep[]) {
    this.creeps = creeps
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

interface PositionGoal {
  advance (options?: FindPathOptions) : CreepMoveResult
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

  private constructor () {
    this.creeps = []
    this.positions = []
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

  public static Builder = class {
    anchor: Position
    built: GridPositionGoal

    private constructor (anchor: Position) {
      this.anchor = anchor
      this.built = new GridPositionGoal()
    }

    static around (position: Position) {
      return new GridPositionGoal.Builder(position)
    }

    with (creep: Creep, position: Position) {
      this.built.creeps.push(creep)
      this.built.positions.push(position)
      return this
    }

    rotate0 () {
      return this
    }

    rotate90 () {
      this.rotateImpl(0, -1, 1, 0)
      return this
    }

    rotate180 () {
      this.rotateImpl(-1, 0, -1, 0)
      return this
    }

    rotate270 () {
      this.rotateImpl(0, 1, -1, 0)
      return this
    }

    // . x ------>
    // y 0    90
    // | 270 180
    // v
    autoRotate () {
      const half = Math.round(MAP_SIDE_SIZE / 2)

      if (this.anchor.x < half) {
        if (this.anchor.y < half) {
          return this.rotate0()
        } else {
          return this.rotate270()
        }
      } else {
        if (this.anchor.y < half) {
          return this.rotate90()
        } else {
          return this.rotate180()
        }
      }
    }

    private rotateImpl (x2x: number, y2x: number, x2y: number, y2y: number) {
      for (const position of this.built.positions) {
        const x = position.x * x2x + position.y * y2x
        const y = position.x * x2y + position.y * y2y
        // for whatever weirdness that may follow
        position.x = Math.round(x)
        position.y = Math.round(y)
      }
    }

    build () : GridPositionGoal {
      for (const position of this.built.positions) {
        const x = this.anchor.x + position.x
        const y = this.anchor.y + position.y
        position.x = x
        position.y = y
      }

      return this.built
    }
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

const positionGoals : PositionGoal[] = []

function plan () : void {
}

function advanceGoals () : void {
  positionGoals.forEach(x => x.advance())
}

function play () : void {
  advanceGoals()
  autoCombat()
}
