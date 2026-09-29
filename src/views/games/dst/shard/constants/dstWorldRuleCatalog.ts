import type { DstWorldOption } from './dstWorldAssets'
import type { DstRuleLevelProfileId } from './dstWorldRuleLevels'
import { getLevelProfile } from './dstWorldRuleLevels'

export type DstWorldConfigTab = 'rules' | 'worldgen'

/** 固定条目：无图标资源时也可展示 */
export interface DstWorldRuleCatalogEntry {
  /** server.ini / worldgenoverride overrides 键 */
  overrideKey: string
  labelZh: string
  /** 与 `src/assets/images/dst/{iconId}.webp` 文件名一致（不含扩展名） */
  iconId?: string
  /** 覆盖分组默认档位 */
  levelProfileId?: DstRuleLevelProfileId
  /** 仅展示、不可编辑 */
  readOnly?: boolean
}

export interface DstWorldRuleCatalogSection {
  id: string
  title: string
  shard: 'master' | 'caves'
  tab: DstWorldConfigTab
  /** 分组内条目默认档位 */
  levelProfileId: DstRuleLevelProfileId
  entries: DstWorldRuleCatalogEntry[]
}

/**
 * 模块划分对齐游戏自带的 master_config.md、caves_config.md 与 leveldataoverride.lua overrides 键。
 * - 世界规则 tab → overrides（世界设置）
 * - 世界生成 tab → overrides（地图生成）
 */
export const DST_WORLD_CONFIG_CATALOG: DstWorldRuleCatalogSection[] = [
  // ── 地上 · 世界规则 ──────────────────────────────────────────
  {
    id: 'master-rules-global',
    title: '全局',
    shard: 'master',
    tab: 'rules',
    levelProfileId: 'dst_difficulty',
    entries: [
      { overrideKey: 'activity', labelZh: '活动', iconId: 'activity', levelProfileId: 'dst_specialevent' },
      { overrideKey: 'autumn', labelZh: '秋', iconId: 'autumn', levelProfileId: 'dst_season' },
      { overrideKey: 'winter', labelZh: '冬', iconId: 'winter', levelProfileId: 'dst_season' },
      { overrideKey: 'spring', labelZh: '春', iconId: 'spring', levelProfileId: 'dst_season' },
      { overrideKey: 'summer', labelZh: '夏', iconId: 'summer', levelProfileId: 'dst_season' },
      { overrideKey: 'day', labelZh: '时长', iconId: 'day', levelProfileId: 'dst_day' },
      { overrideKey: 'spawnmode', labelZh: '出生模式', iconId: 'spawnmode', levelProfileId: 'dst_spawnmode' },
      { overrideKey: 'ghostenabled', labelZh: '冒险家死亡', iconId: 'survivor_death', levelProfileId: 'dst_ghost' },
      { overrideKey: 'portalresurection', labelZh: '在绚丽之门复活', iconId: 'revive_at_florid_postern', levelProfileId: 'dst_toggle' },
      { overrideKey: 'ghostsanitydrain', labelZh: '鬼魂理智值惩罚', iconId: 'ghost_sanity_drain', levelProfileId: 'dst_toggle' },
      { overrideKey: 'resettime', labelZh: '死亡重置倒计时', iconId: 'death_reset_timer', levelProfileId: 'dst_resettime' },
      { overrideKey: 'beefaloheat', labelZh: '皮弗娄牛交配频率', iconId: 'beefalo_heat', levelProfileId: 'dst_difficulty' },
      { overrideKey: 'krampus', labelZh: '坎普斯', iconId: 'krampus', levelProfileId: 'dst_difficulty' },
    ],
  },
  {
    id: 'master-rules-events',
    title: '活动',
    shard: 'master',
    tab: 'rules',
    levelProfileId: 'dst_event',
    entries: [
      { overrideKey: 'crow_carnival', labelZh: '盛夏鸦年华', iconId: 'midsummer_cawnival' },
      { overrideKey: 'hallowed_nights', iconId: 'hallowed_nights', labelZh: '万圣夜' },
      { overrideKey: 'winters_feast', iconId: 'winters_feast', labelZh: '冬季盛宴' },
      { overrideKey: 'year_of_the_gobbler', iconId: 'year_of_the_gobbler', labelZh: '火鸡之年' },
      { overrideKey: 'year_of_the_varg', iconId: 'year_of_the_varg', labelZh: '座狼之年' },
      { overrideKey: 'year_of_the_pig', iconId: 'year_of_the_pig_king', labelZh: '猪王之年' },
      { overrideKey: 'year_of_the_carrat', labelZh: '胡萝卜鼠之年', iconId: 'carrat' },
      { overrideKey: 'year_of_the_beefalo', labelZh: '皮弗娄牛之年', iconId: 'beefalo' },
      { overrideKey: 'year_of_the_catcoon', labelZh: '浣猫之年', iconId: 'catcoon' },
      { overrideKey: 'year_of_the_bunnyman', labelZh: '兔人之年', iconId: 'bunnyman' },
      { overrideKey: 'year_of_the_dragonfly', labelZh: '龙蝇之年', iconId: 'dragonfly' },
      { overrideKey: 'year_of_the_snake', iconId: 'year_of_the_depths_worm', labelZh: '洞穴蠕虫之年' },
      { overrideKey: 'year_of_the_knight', labelZh: '发条骑士之年', iconId: 'clockwork_mobs' },
    ],
  },
  {
    id: 'master-rules-adventurers',
    title: '冒险家',
    shard: 'master',
    tab: 'rules',
    levelProfileId: 'dst_difficulty',
    entries: [
      { overrideKey: 'extrastartingitems', labelZh: '额外起始资源', iconId: 'extra_starting_resource', levelProfileId: 'dst_extrastartingitems' },
      { overrideKey: 'seasonalstartingitems', labelZh: '季节起始物品', iconId: 'seasonal_starting_items', levelProfileId: 'dst_none_default' },
      { overrideKey: 'spawnprotection', labelZh: '防骚扰出生保护', iconId: 'griefer_spawn_protection', levelProfileId: 'dst_spawnprotection' },
      { overrideKey: 'dropeverythingondespawn', labelZh: '离开游戏后物品掉落', iconId: 'drop_items_on_disconnect', levelProfileId: 'dst_drop_items' },
      { overrideKey: 'healthpenalty', labelZh: '生命值上限惩罚', iconId: 'max_health_penalty', levelProfileId: 'dst_health_penalty' },
      { overrideKey: 'lessdamagetaken', labelZh: '受到的伤害', iconId: 'damage_taken', levelProfileId: 'dst_damage_taken' },
      { overrideKey: 'temperaturedamage', labelZh: '温度伤害', iconId: 'temperature_damage', levelProfileId: 'dst_nonlethal' },
      { overrideKey: 'hunger', labelZh: '饥饿伤害', iconId: 'hunger_damage', levelProfileId: 'dst_nonlethal' },
      { overrideKey: 'darkness', labelZh: '黑暗伤害', iconId: 'darkness_damage', levelProfileId: 'dst_nonlethal' },
      { overrideKey: 'shadowcreatures', labelZh: '理智怪兽', iconId: 'sanity_monsters' },
      { overrideKey: 'brightmarecreatures', labelZh: '启蒙怪兽', iconId: 'enlightenment_monsters' },
    ],
  },
  {
    id: 'master-rules-world',
    title: '世界',
    shard: 'master',
    tab: 'rules',
    levelProfileId: 'dst_difficulty',
    entries: [
      { overrideKey: 'hounds', labelZh: '猎犬攻击', iconId: 'hound_attacks' },
      { overrideKey: 'winterhounds', labelZh: '寒冰猎犬群', iconId: 'ice_hound_waves' },
      { overrideKey: 'summerhounds', labelZh: '火焰猎犬群', iconId: 'fire_hound_waves' },
      { overrideKey: 'lunarhail_frequency', labelZh: '月雹', iconId: 'lunar_hail' },
      { overrideKey: 'petrification', labelZh: '森林石化', iconId: 'forest_petrification', levelProfileId: 'dst_petrification' },
      { overrideKey: 'meteorshowers', labelZh: '流星频率', iconId: 'meteor_frequency' },
      { overrideKey: 'wanderingtrader_enabled', labelZh: '流浪商人', iconId: 'wandering_trader' },
      { overrideKey: 'alternatehunt', labelZh: '狩猎惊喜', iconId: 'hunting_surprises' },
      { overrideKey: 'wildfires', labelZh: '自燃', iconId: 'smoldering' },
      { overrideKey: 'rifts_enabled', labelZh: '荒野裂隙', iconId: 'lunar_rifts', levelProfileId: 'dst_rifts' },
      { overrideKey: 'rifts_frequency', labelZh: '荒野裂隙频率', iconId: 'lunar_rifts' },
      { overrideKey: 'hunt', labelZh: '足迹', iconId: 'hunts' },
      { overrideKey: 'lightning', labelZh: '闪电', iconId: 'lightning' },
      { overrideKey: 'weather', labelZh: '雨', iconId: 'weather' },
      { overrideKey: 'frograin', labelZh: '青蛙雨', iconId: 'frog_rain' },
    ],
  },
  {
    id: 'master-rules-regrowth',
    title: '资源再生',
    shard: 'master',
    tab: 'rules',
    levelProfileId: 'dst_regrowth',
    entries: [
      { overrideKey: 'regrowth', labelZh: '世界再生', iconId: 'world_regrowth' },
      { overrideKey: 'cactus_regrowth', labelZh: '仙人掌', iconId: 'cactus' },
      { overrideKey: 'basicresource_regrowth', labelZh: '基础资源', iconId: 'basic_resources', levelProfileId: 'dst_none_default' },
      { overrideKey: 'twiggytrees_regrowth', labelZh: '多枝树', iconId: 'twiggy_tree' },
      { overrideKey: 'evergreen_regrowth', labelZh: '常青树', iconId: 'trees' },
      { overrideKey: 'moon_tree_regrowth', labelZh: '月树', iconId: 'luner_tree' },
      { overrideKey: 'deciduoustree_regrowth', labelZh: '桦栗树', iconId: 'birchnut_tree' },
      { overrideKey: 'palmconetree_regrowth', labelZh: '棕榈松果树', iconId: 'palmcone_tree' },
      { overrideKey: 'saltstack_regrowth', labelZh: '盐堆', iconId: 'salt_formation' },
      { overrideKey: 'carrots_regrowth', labelZh: '胡萝卜', iconId: 'carrot' },
      { overrideKey: 'reeds_regrowth', labelZh: '芦苇', iconId: 'reeds' },
      { overrideKey: 'flowers_regrowth', labelZh: '花', iconId: 'flower' },
    ],
  },
  {
    id: 'master-rules-portal',
    title: '非自然传送门资源',
    shard: 'master',
    tab: 'rules',
    levelProfileId: 'dst_difficulty',
    entries: [
      { overrideKey: 'portal_spawnrate', labelZh: '传送频率', iconId: 'portal_activity' },
      { overrideKey: 'lightcrab_portalrate', labelZh: '发光蟹', iconId: 'crustashine' },
      { overrideKey: 'palmcone_seed_portalrate', labelZh: '棕榈松果树芽', iconId: 'palmcone_sprout' },
      { overrideKey: 'powder_monkey_portalrate', labelZh: '火药猴', iconId: 'powder_monkey' },
      { overrideKey: 'monkeytail_portalrate', labelZh: '猴尾草', iconId: 'monkeytail' },
      { overrideKey: 'bananabush_portalrate', labelZh: '香蕉丛', iconId: 'banana_bush' },
    ],
  },
  {
    id: 'master-rules-creatures',
    title: '生物',
    shard: 'master',
    tab: 'rules',
    levelProfileId: 'dst_difficulty',
    entries: [
      { overrideKey: 'gnarwail', labelZh: '一角鲸', iconId: 'gnarwail' },
      { overrideKey: 'penguins', labelZh: '企鸥', iconId: 'pengull' },
      { overrideKey: 'bunnymen_setting', labelZh: '兔人', iconId: 'bunnyman' },
      { overrideKey: 'rabbits_setting', labelZh: '兔子', iconId: 'rabbit' },
      { overrideKey: 'otters_setting', labelZh: '水獭掠夺者', iconId: 'marotter' },
      { overrideKey: 'catcoons', labelZh: '浣猫', iconId: 'catcoon' },
      { overrideKey: 'perd', labelZh: '火鸡', iconId: 'gobbler' },
      { overrideKey: 'pigs_setting', labelZh: '猪', iconId: 'pig' },
      { overrideKey: 'grassgekkos', labelZh: '草壁虎转化', iconId: 'grass_gekko_morphing' },
      { overrideKey: 'bees_setting', labelZh: '蜜蜂', iconId: 'bee' },
      { overrideKey: 'butterfly', labelZh: '蝴蝶', iconId: 'butterfly' },
      { overrideKey: 'fishschools', labelZh: '鱼群', iconId: 'schools_of_fish' },
      { overrideKey: 'birds', labelZh: '鸟', iconId: 'birds' },
      { overrideKey: 'moles_setting', labelZh: '鼹鼠', iconId: 'moleworm' },
      { overrideKey: 'wobsters', labelZh: '龙虾', iconId: 'wobster' },
    ],
  },
  {
    id: 'master-rules-hostile',
    title: '敌对生物',
    shard: 'master',
    tab: 'rules',
    levelProfileId: 'dst_difficulty',
    entries: [
      { overrideKey: 'pirates', labelZh: '月亮码头海盗', iconId: 'moon_quay_pirates' },
      { overrideKey: 'wasps', labelZh: '杀人蜂', iconId: 'killer_bee' },
      { overrideKey: 'walrus_setting', labelZh: '海象', iconId: 'mac_tusk' },
      { overrideKey: 'hounds', labelZh: '猎犬', iconId: 'hound' },
      { overrideKey: 'mosquitos', labelZh: '蚊子', iconId: 'mosquito' },
      { overrideKey: 'spiders', labelZh: '蜘蛛', iconId: 'spider' },
      { overrideKey: 'spider_warriors', labelZh: '蜘蛛战士', iconId: 'spider_warrior' },
      { overrideKey: 'bats', labelZh: '蝙蝠', iconId: 'batilisk' },
      { overrideKey: 'frogs', labelZh: '青蛙', iconId: 'frog' },
      { overrideKey: 'lureplants', labelZh: '食人花', iconId: 'lureplant' },
      { overrideKey: 'cookiecutters', labelZh: '饼干切割机', iconId: 'cookie_cutter' },
      { overrideKey: 'merms', labelZh: '鱼人', iconId: 'merm' },
      { overrideKey: 'squid', labelZh: '鱿鱼', iconId: 'skittersquid' },
      { overrideKey: 'sharks', labelZh: '鲨鱼', iconId: 'shark' },
    ],
  },
  {
    id: 'master-rules-giants',
    title: '巨兽',
    shard: 'master',
    tab: 'rules',
    levelProfileId: 'dst_difficulty',
    entries: [
      { overrideKey: 'klaus', labelZh: '克劳斯', iconId: 'klaus' },
      { overrideKey: 'sharkboi', labelZh: '大霜鲨', iconId: 'frostjaw' },
      { overrideKey: 'crabking', labelZh: '帝王蟹', iconId: 'crabking' },
      { overrideKey: 'eyeofterror', labelZh: '恐怖之眼', iconId: 'eye_of_terror' },
      { overrideKey: 'daywalker', labelZh: '拾荒疯猪', iconId: 'scrappy_werepig' },
      { overrideKey: 'fruitfly', labelZh: '果蝇王', iconId: 'lord_of_the_fruit_flies' },
      { overrideKey: 'liefs', labelZh: '树精守卫', iconId: 'treeguard' },
      { overrideKey: 'deciduousmonster', labelZh: '桦树精', iconId: 'poison_birchnut_tree' },
      { overrideKey: 'bearger', labelZh: '熊獾', iconId: 'bearger' },
      { overrideKey: 'deerclops', labelZh: '独眼巨鹿', iconId: 'deerclops' },
      { overrideKey: 'antliontribute', labelZh: '蚁狮朝贡', iconId: 'antlion' },
      { overrideKey: 'beequeen', labelZh: '蜂王', iconId: 'bee_queen' },
      { overrideKey: 'spiderqueen', labelZh: '蜘蛛女王', iconId: 'spider_queen' },
      { overrideKey: 'malbatross', labelZh: '邪天翁', iconId: 'malbatross' },
      { overrideKey: 'goosemoose', labelZh: '麋鹿鹅', iconId: 'moose_goose' },
      { overrideKey: 'dragonfly', labelZh: '龙蝇', iconId: 'dragonfly' },
    ],
  },
  {
    id: 'master-rules-moon-mutation',
    title: '月亮变异',
    shard: 'master',
    tab: 'rules',
    levelProfileId: 'dst_difficulty',
    entries: [
      { overrideKey: 'mutated_bird_gestalt', labelZh: '亮喙鸟', iconId: 'bright_beaked_bird' },
      { overrideKey: 'mutated_birds', labelZh: '变异的鸟', iconId: 'mutated_birds' },
      { overrideKey: 'mutated_merm', labelZh: '变异鱼人', iconId: 'mutated_merm' },
      { overrideKey: 'mutated_hounds', labelZh: '恐怖猎犬', iconId: 'horror_hound' },
      { overrideKey: 'mutated_deerclops', labelZh: '晶体独眼巨鹿', iconId: 'crystal_deerclops' },
      { overrideKey: 'mutated_buzzard_gestalt', labelZh: '水晶冠秃鹫', iconId: 'crystal_crested_buzzard' },
      { overrideKey: 'penguins_moon', labelZh: '永冻企鸥', iconId: 'permafrost_pengull' },
      { overrideKey: 'moon_spider', labelZh: '破碎蜘蛛', iconId: 'shatter_spider' },
      { overrideKey: 'moon_spiders', labelZh: '破碎蜘蛛洞', iconId: 'shattered_Spider_hole' },
      { overrideKey: 'mutated_bearger', labelZh: '装甲熊獾', iconId: 'armored_bearger' },
      { overrideKey: 'mutated_warg', labelZh: '附身座狼', iconId: 'possessed_varg' },
    ],
  },

  // ── 洞穴 · 世界规则 ──────────────────────────────────────────
  {
    id: 'caves-rules-global',
    title: '世界',
    shard: 'caves',
    tab: 'rules',
    levelProfileId: 'dst_difficulty',
    entries: [
      { overrideKey: 'earthquakes', labelZh: '地震频率', iconId: 'earthquake' },
      { overrideKey: 'worms', labelZh: '大蠕虫', iconId: 'great_depths_worm' },
      { overrideKey: 'wormattacks', labelZh: '洞穴蠕虫攻击', iconId: 'depths_worm_attacks' },
      { overrideKey: 'rifts_enabled_cave', labelZh: '荒野裂隙', levelProfileId: 'dst_rifts', iconId: 'shadow_rifts' },
      { overrideKey: 'rifts_frequency_cave', labelZh: '荒野裂隙频率', iconId: 'shadow_rifts' },
      { overrideKey: 'atriumgate', labelZh: '远古大门', iconId: 'ancient_gateway', levelProfileId: 'dst_regrowth' },
      { overrideKey: 'acidrain_enabled', labelZh: '酸雨', iconId: 'acid_rain', levelProfileId: 'dst_toggle' },
      { overrideKey: 'weather', labelZh: '雨', iconId: 'weather' },
    ],
  },
  {
    id: 'caves-rules-regrowth',
    title: '资源再生',
    shard: 'caves',
    tab: 'rules',
    levelProfileId: 'dst_regrowth',
    entries: [
      { overrideKey: 'regrowth', labelZh: '世界再生', iconId: 'world_regrowth' },
      { overrideKey: 'lightflier_flower_regrowth', labelZh: '光虫花', iconId: 'lightFlier_flower' },
      { overrideKey: 'twiggytrees_regrowth', labelZh: '多枝树', iconId: 'twiggy_tree' },
      { overrideKey: 'tree_rock_regrowth', labelZh: '巨石枝', iconId: 'boulderbough' },
      { overrideKey: 'evergreen_regrowth', labelZh: '常青树', iconId: 'trees' },
      { overrideKey: 'mushtree_moon_regrowth', labelZh: '月亮蘑菇树', iconId: 'lunar_mushtree' },
      { overrideKey: 'reeds_regrowth', labelZh: '芦苇', iconId: 'reeds' },
      { overrideKey: 'flower_cave_regrowth', labelZh: '荧光花', iconId: 'light_flower' },
      { overrideKey: 'mushtree_regrowth', labelZh: '蘑菇树', iconId: 'mushroom_tree' },
    ],
  },
  {
    id: 'caves-rules-creatures',
    title: '生物',
    shard: 'caves',
    tab: 'rules',
    levelProfileId: 'dst_difficulty',
    entries: [
      { overrideKey: 'bunnymen_setting', labelZh: '兔人', iconId: 'bunnyman' },
      { overrideKey: 'dustmoths', labelZh: '尘蛾', iconId: 'dust_moth' },
      { overrideKey: 'pigs_setting', labelZh: '猪', iconId: 'pig' },
      { overrideKey: 'lightfliers', labelZh: '球状光虫', iconId: 'bioluminescence' },
      { overrideKey: 'rocky_setting', labelZh: '石虾', iconId: 'stone_shrimp' },
      { overrideKey: 'monkey_setting', labelZh: '穴居猴', iconId: 'cave_monkey' },
      { overrideKey: 'grassgekkos', labelZh: '草壁虎转化', iconId: 'grass_gekko_morphing' },
      { overrideKey: 'mushgnome', labelZh: '蘑菇地精', iconId: 'mushgnome' },
      { overrideKey: 'slurtles_setting', labelZh: '蛞蝓龟', iconId: 'slug_turtle' },
      { overrideKey: 'snurtles', labelZh: '蜗牛龟', iconId: 'snail_turtle' },
      { overrideKey: 'moles_setting', labelZh: '鼹鼠', iconId: 'moleworm' },
    ],
  },
  {
    id: 'caves-rules-hostile',
    title: '敌对生物',
    shard: 'caves',
    tab: 'rules',
    levelProfileId: 'dst_difficulty',
    entries: [
      { overrideKey: 'spider_spitter', labelZh: '喷射蜘蛛', iconId: 'spider_spitter' },
      { overrideKey: 'itemmimics', labelZh: '拟态蠕虫', iconId: 'item_mimic' },
      { overrideKey: 'chest_mimics', labelZh: '暴躁箱子', iconId: 'chest_mimic' },
      { overrideKey: 'cave_spiders', labelZh: '洞穴蜘蛛', iconId: 'cave_spider' },
      { overrideKey: 'spider_hider', labelZh: '穴居蜘蛛', iconId: 'spider_hider' },
      { overrideKey: 'spiders_setting', labelZh: '蜘蛛', iconId: 'spider' },
      { overrideKey: 'spider_warriors', labelZh: '蜘蛛战士', iconId: 'spider_warrior' },
      { overrideKey: 'bats_setting', labelZh: '蝙蝠', iconId: 'batilisk' },
      { overrideKey: 'molebats', labelZh: '裸鼹蝠', iconId: 'mole_bat' },
      { overrideKey: 'nightmarecreatures', labelZh: '遗迹梦魇', iconId: 'ancient_spirit' },
      { overrideKey: 'merms', labelZh: '鱼人', iconId: 'merm' },
    ],
  },
  {
    id: 'caves-rules-giants',
    title: '巨兽',
    shard: 'caves',
    tab: 'rules',
    levelProfileId: 'dst_difficulty',
    entries: [
      { overrideKey: 'fruitfly', labelZh: '果蝇王', iconId: 'lord_of_the_fruit_flies' },
      { overrideKey: 'liefs', labelZh: '树精守卫', iconId: 'treeguard' },
      { overrideKey: 'daywalker', labelZh: '梦魇疯猪', iconId: 'scrappy_werepig' },
      { overrideKey: 'toadstool', labelZh: '毒菌蟾蜍', iconId: 'toadstool' },
      { overrideKey: 'spiderqueen', labelZh: '蜘蛛女王', iconId: 'spider_queen' },
    ],
  },
  {
    id: 'caves-rules-moon-mutation',
    title: '月亮变异',
    shard: 'caves',
    tab: 'rules',
    levelProfileId: 'dst_difficulty',
    entries: [
      { overrideKey: 'mutated_birds', labelZh: '变异的鸟', iconId: 'mutated_birds' },
      { overrideKey: 'mutated_merm', labelZh: '变异鱼人', iconId: 'mutated_merm' },
      { overrideKey: 'moon_spider', labelZh: '破碎蜘蛛', iconId: 'shatter_spider' },
      { overrideKey: 'moon_spiders', labelZh: '破碎蜘蛛洞', iconId: 'shattered_Spider_hole' },
    ],
  },

  // ── 地上 · 世界生成 ──────────────────────────────────────────
  {
    id: 'master-worldgen-global',
    title: '全局',
    shard: 'master',
    tab: 'worldgen',
    levelProfileId: 'starting_season',
    entries: [
      { overrideKey: 'season_start', labelZh: '初始季节', iconId: 'season_start', levelProfileId: 'starting_season' },
    ],
  },
  {
    id: 'master-worldgen-world',
    title: '世界',
    shard: 'master',
    tab: 'worldgen',
    levelProfileId: 'dst_worldgen',
    entries: [
      { overrideKey: 'task_set', labelZh: '生物群落', iconId: 'biomes', levelProfileId: 'dst_task_set' },
      { overrideKey: 'start_location', labelZh: '初始环境', iconId: 'spawn_area', levelProfileId: 'dst_start_location' },
      { overrideKey: 'world_size', labelZh: '世界大小', iconId: 'world_size', levelProfileId: 'dst_world_size' },
      { overrideKey: 'branching', labelZh: '岔路地形', iconId: 'land_branch', levelProfileId: 'dst_branching' },
      { overrideKey: 'loop', labelZh: '环状地形', iconId: 'land_loop', levelProfileId: 'dst_loop' },
      { overrideKey: 'roads', labelZh: '道路', iconId: 'roads', levelProfileId: 'dst_none_default' },
      { overrideKey: 'touchstone', labelZh: '试金石', iconId: 'touch_stone' },
      { overrideKey: 'boons', labelZh: '前辈', iconId: 'set_pieces' },
      { overrideKey: 'prefabswaps_start', labelZh: '初始资源的多样性', iconId: 'starting_variety', levelProfileId: 'dst_prefabswaps' },
      { overrideKey: 'junk_pile', labelZh: '垃圾场', iconId: 'junk_yard' },
      { overrideKey: 'moon_fissure', labelZh: '天体裂隙', iconId: 'celestial_fissure' },
      { overrideKey: 'itemmimics', labelZh: '小丑', iconId: 'item_mimic' },
      { overrideKey: 'terrariumchest', labelZh: '盒中泰拉', iconId: 'terrarium' },
      { overrideKey: 'stageplays', labelZh: '舞台剧', iconId: 'stage_plays' },
    ],
  },
  {
    id: 'master-worldgen-resources',
    title: '资源',
    shard: 'master',
    tab: 'worldgen',
    levelProfileId: 'dst_worldgen',
    entries: [
      { overrideKey: 'cactus', labelZh: '仙人球', iconId: 'cactus' },
      { overrideKey: 'ocean_bullkelp', labelZh: '公牛海带', iconId: 'bull_kelp' },
      { overrideKey: 'rock', labelZh: '卵石', iconId: 'boulder' },
      { overrideKey: 'marshbush', labelZh: '尖刺灌木', iconId: 'spiky_bush' },
      { overrideKey: 'moon_sapling', labelZh: '月亮树苗', iconId: 'lunar_sapling' },
      { overrideKey: 'moon_rock', labelZh: '月亮石', iconId: 'lunar_rock' },
      { overrideKey: 'moon_tree', labelZh: '月树', iconId: 'luner_tree' },
      { overrideKey: 'sapling', labelZh: '树苗', iconId: 'sapling' },
      { overrideKey: 'trees', labelZh: '树（全部）', iconId: 'trees' },
      { overrideKey: 'palmconetree', labelZh: '棕榈松果树', iconId: 'palmcone_tree' },
      { overrideKey: 'ponds', labelZh: '池塘', iconId: 'pond' },
      { overrideKey: 'meteorspawner', labelZh: '流星区域', iconId: 'meteor_field' },
      { overrideKey: 'berrybush', labelZh: '浆果丛', iconId: 'berry_bush' },
      { overrideKey: 'moon_bullkelp', labelZh: '海岸公牛海带', iconId: 'bull_kelp' },
      { overrideKey: 'moon_starfish', labelZh: '海星', iconId: 'anenemy' },
      { overrideKey: 'ocean_seastack', labelZh: '海蚀柱', iconId: 'sea_stack' },
      { overrideKey: 'moon_hotspring', labelZh: '温泉', iconId: 'hot_spring' },
      { overrideKey: 'flint', labelZh: '燧石', iconId: 'flint' },
      { overrideKey: 'rock_avocado', labelZh: '石果灌木丛', iconId: 'stone_fruit_bush' },
      { overrideKey: 'carrot', labelZh: '胡萝卜', iconId: 'carrot' },
      { overrideKey: 'reeds', labelZh: '芦苇', iconId: 'reeds' },
      { overrideKey: 'flowers', labelZh: '花、恶魔花', iconId: 'flower' },
      { overrideKey: 'grass', labelZh: '草', iconId: 'grass_tuft' },
      { overrideKey: 'mushroom', labelZh: '蘑菇', iconId: 'mushroom' },
      { overrideKey: 'rock_ice', labelZh: '迷你冰川', iconId: 'mini_glacier' },
      { overrideKey: 'tumbleweed', labelZh: '风滚草', iconId: 'tumbleweed' },
    ],
  },
  {
    id: 'master-worldgen-creatures',
    title: '生物以及刷新点',
    shard: 'master',
    tab: 'worldgen',
    levelProfileId: 'dst_worldgen',
    entries: [
      { overrideKey: 'lightninggoat', labelZh: '伏特羊', iconId: 'volt_goat' },
      { overrideKey: 'rabbits', labelZh: '兔子', iconId: 'rabbit' },
      { overrideKey: 'otterden', labelZh: '水獭掠夺者窝点', iconId: 'marotter_den' },
      { overrideKey: 'saladmanders', labelZh: '沙拉蝾螈', iconId: 'saladmander' },
      { overrideKey: 'catcoon', labelZh: '浣猫', iconId: 'catcoon' },
      { overrideKey: 'pigs', labelZh: '猪人', iconId: 'pig' },
      { overrideKey: 'beefalo', labelZh: '皮弗娄牛', iconId: 'beefalo' },
      { overrideKey: 'buzzard', labelZh: '秃鹫', iconId: 'buzzard' },
      { overrideKey: 'carrat', labelZh: '胡萝卜鼠', iconId: 'carrat' },
      { overrideKey: 'bees', labelZh: '蜜蜂', iconId: 'bee' },
      { overrideKey: 'ocean_shoal', labelZh: '鱼群', iconId: 'shoal' },
      { overrideKey: 'moles', labelZh: '鼹鼠', iconId: 'moleworm' },
      { overrideKey: 'ocean_wobsterden', labelZh: '龙虾窝', iconId: 'wobster_mound' },
    ],
  },
  {
    id: 'master-worldgen-hostile',
    title: '敌对生物以及刷新点',
    shard: 'master',
    tab: 'worldgen',
    levelProfileId: 'dst_worldgen',
    entries: [
      { overrideKey: 'chess', labelZh: '发条生物', iconId: 'clockwork_mobs' },
      { overrideKey: 'angrybees', labelZh: '杀人蜂', iconId: 'killer_beehive' },
      { overrideKey: 'ocean_waterplant', labelZh: '海草', iconId: 'sea_weed' },
      { overrideKey: 'walrus', labelZh: '海象巢穴', iconId: 'mac_tusk_camp' },
      { overrideKey: 'houndmound', labelZh: '猎犬丘', iconId: 'hound_mound' },
      { overrideKey: 'moon_spiders', labelZh: '破碎蜘蛛洞', iconId: 'shattered_Spider_hole' },
      { overrideKey: 'spiders', labelZh: '蜘蛛', iconId: 'spider_den' },
      { overrideKey: 'tentacles', labelZh: '触手', iconId: 'tentacle' },
      { overrideKey: 'tallbirds', labelZh: '高鸟', iconId: 'tallbird' },
      { overrideKey: 'merm', labelZh: '鱼人', iconId: 'leaky_shack' },
    ],
  },

  // ── 洞穴 · 世界生成 ──────────────────────────────────────────
  {
    id: 'caves-worldgen-world',
    title: '世界',
    shard: 'caves',
    tab: 'worldgen',
    levelProfileId: 'dst_worldgen',
    entries: [
      { overrideKey: 'task_set', labelZh: '生物群落', iconId: 'biomes', levelProfileId: 'dst_cave_task_set' },
      { overrideKey: 'start_location', labelZh: '初始环境', levelProfileId: 'dst_cave_start_location', iconId: 'spawn_area' },
      { overrideKey: 'world_size', labelZh: '世界大小', levelProfileId: 'dst_world_size', iconId: 'world_size' },
      { overrideKey: 'branching', labelZh: '岔路地形', levelProfileId: 'dst_branching', iconId: 'land_branch' },
      { overrideKey: 'loop', labelZh: '环状地形', levelProfileId: 'dst_loop', iconId: 'land_loop' },
      { overrideKey: 'touchstone', labelZh: '试金石', iconId: 'touch_stone' },
      { overrideKey: 'cavelight', labelZh: '光照', levelProfileId: 'dst_regrowth', iconId: 'sinkhole_light' },
      { overrideKey: 'boons', labelZh: '前辈', iconId: 'set_pieces' },
      { overrideKey: 'prefabswaps_start', labelZh: '初始资源的多样性', levelProfileId: 'dst_prefabswaps', iconId: 'starting_variety' },
    ],
  },
  {
    id: 'caves-worldgen-resources',
    title: '资源再生',
    shard: 'caves',
    tab: 'worldgen',
    levelProfileId: 'dst_worldgen',
    entries: [
      { overrideKey: 'rock', labelZh: '卵石', iconId: 'boulder' },
      { overrideKey: 'wormlights', labelZh: '发光浆果', iconId: 'glow_berry' },
      { overrideKey: 'marshbush', labelZh: '尖刺灌木', iconId: 'spiky_bush' },
      { overrideKey: 'tree_rock', labelZh: '巨石枝', iconId: 'boulderbough' },
      { overrideKey: 'sapling', labelZh: '树苗', iconId: 'sapling' },
      { overrideKey: 'trees', labelZh: '树（全部）', iconId: 'trees' },
      { overrideKey: 'cave_ponds', labelZh: '池塘', iconId: 'pond' },
      { overrideKey: 'banana', labelZh: '洞穴香蕉', iconId: 'cave_banana_tree' },
      { overrideKey: 'berrybush', labelZh: '浆果丛', iconId: 'berry_bush' },
      { overrideKey: 'flint', labelZh: '燧石', iconId: 'flint' },
      { overrideKey: 'reeds', labelZh: '芦苇', iconId: 'reeds' },
      { overrideKey: 'lichen', labelZh: '苔藓', iconId: 'lichen' },
      { overrideKey: 'grass', labelZh: '草', iconId: 'grass_tuft' },
      { overrideKey: 'flower_cave', labelZh: '荧光花', iconId: 'light_flower' },
      { overrideKey: 'fern', labelZh: '蕨类植物', iconId: 'cave_fern' },
      { overrideKey: 'mushroom', labelZh: '蘑菇', iconId: 'mushroom' },
      { overrideKey: 'mushtree', labelZh: '蘑菇树', iconId: 'mushroom_tree' },
    ],
  },
  {
    id: 'caves-worldgen-creatures',
    title: '生物以及刷新点',
    shard: 'caves',
    tab: 'worldgen',
    levelProfileId: 'dst_worldgen',
    entries: [
      { overrideKey: 'bunnymen', labelZh: '兔人', iconId: 'rabbit_hutch' },
      { overrideKey: 'slurper', labelZh: '啜食者', iconId: 'slurper' },
      { overrideKey: 'monkey', labelZh: '猴子', iconId: 'splumonkey_pod' },
      { overrideKey: 'rocky', labelZh: '石虾', iconId: 'stone_shrimp' },
      { overrideKey: 'slurtles', labelZh: '蛞蝓龟和蜗牛龟', iconId: 'slurtle_mound' },
    ],
  },
  {
    id: 'caves-worldgen-hostile',
    title: '敌对生物以及刷新点',
    shard: 'caves',
    tab: 'worldgen',
    levelProfileId: 'dst_worldgen',
    entries: [
      { overrideKey: 'chess', labelZh: '发条生物', iconId: 'clockwork_mobs' },
      { overrideKey: 'cave_spiders', labelZh: '洞穴蜘蛛', iconId: 'spilagmite' },
      { overrideKey: 'worms', labelZh: '洞穴蠕虫', iconId: 'depths_worm' },
      { overrideKey: 'spiders', labelZh: '蜘蛛', iconId: 'spider_den' },
      { overrideKey: 'bats', labelZh: '蝙蝠', iconId: 'batilisk' },
      { overrideKey: 'fissure', labelZh: '裂隙', iconId: 'cave_cleft' },
      { overrideKey: 'tentacles', labelZh: '触手', iconId: 'tentacle' },
    ],
  },
]

export interface DstWorldRuleRowView {
  overrideKey: string
  labelZh: string
  image?: string
  sectionId: string
  sectionTitle: string
  levelProfileId: DstRuleLevelProfileId
  readOnly?: boolean
}

function resolveImage(
  entry: DstWorldRuleCatalogEntry,
  iconById: Map<string, DstWorldOption>,
): string | undefined {
  if (!entry.iconId) {
    return undefined
  }
  return iconById.get(entry.iconId)?.image
}

export function getCatalogSections(
  shard: 'master' | 'caves',
  tab: DstWorldConfigTab,
): DstWorldRuleCatalogSection[] {
  return DST_WORLD_CONFIG_CATALOG.filter(s => s.shard === shard && s.tab === tab)
}

export function buildWorldConfigRows(
  shard: 'master' | 'caves',
  tab: DstWorldConfigTab,
  allRuleIcons: DstWorldOption[],
): DstWorldRuleRowView[] {
  const iconById = new Map(allRuleIcons.map(o => [o.id, o]))
  const rows: DstWorldRuleRowView[] = []

  for (const section of getCatalogSections(shard, tab)) {
    for (const entry of section.entries) {
      rows.push({
        overrideKey: entry.overrideKey,
        labelZh: entry.labelZh,
        image: resolveImage(entry, iconById),
        sectionId: section.id,
        sectionTitle: section.title,
        levelProfileId: entry.levelProfileId ?? section.levelProfileId,
        readOnly: entry.readOnly,
      })
    }
  }

  return rows
}

export function groupWorldConfigRows(rows: DstWorldRuleRowView[]) {
  const sectionOrder: string[] = []
  const grouped = new Map<string, { title: string, items: DstWorldRuleRowView[] }>()

  for (const row of rows) {
    if (!grouped.has(row.sectionId)) {
      sectionOrder.push(row.sectionId)
      grouped.set(row.sectionId, { title: row.sectionTitle, items: [] })
    }
    grouped.get(row.sectionId)!.items.push(row)
  }

  return sectionOrder
    .map((id) => {
      const group = grouped.get(id)
      if (!group || group.items.length === 0) {
        return null
      }
      return { sectionId: id, title: group.title, items: group.items }
    })
    .filter((section): section is NonNullable<typeof section> => section !== null)
}

export function resolveRowLevelProfile(row: DstWorldRuleRowView) {
  return getLevelProfile(row.levelProfileId)
}

/** @deprecated 兼容旧引用 */
export const buildWorldRuleRows = buildWorldConfigRows
/** @deprecated 兼容旧引用 */
export const groupWorldRuleRows = groupWorldConfigRows
