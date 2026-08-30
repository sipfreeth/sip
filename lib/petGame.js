// lib/petGame.js
//
// Logic หลักของระบบเกมเลี้ยงสัตว์ — แยกเป็นระบบ EXP ของตัวเอง ไม่เกี่ยวกับ Tier เดิมเลย
// Point ที่ใช้ซื้ออาหาร/ขนม/เครื่องแต่งกาย เป็น Point ก้อนเดียวกับที่ใช้แลกของรางวัลจริง (reward_points เดิม)

import { supabase } from './supabaseClient.js';
import { getCurrentYearStart } from './tiers.js';

// ยอด Point ที่ใช้ได้จริง — สูตรเดียวกับระบบแลกของรางวัล (api/member-action.js) เป๊ะๆ
// กันปัญหาใช้แต้มซ้ำระหว่างระบบแลกของรางวัลจริงกับระบบเกมเลี้ยงสัตว์
async function getSpendableBalance(memberId) {
  const yearStart = getCurrentYearStart();
  const [earnedRes, spentRes] = await Promise.all([
    supabase.from('points_ledger').select('reward_points').eq('member_id', memberId).gte('created_at', yearStart),
    supabase.from('redemptions').select('points_spent').eq('member_id', memberId).gte('created_at', yearStart),
  ]);
  const earned = (earnedRes.data || []).reduce((sum, row) => sum + row.reward_points, 0);
  const spent = (spentRes.data || []).reduce((sum, row) => sum + row.points_spent, 0);
  return earned - spent;
}

const SPECIES_LIST = [
  { id: 'cat', name: 'แมว' },
  { id: 'dog', name: 'สุนัข' },
  { id: 'bird', name: 'นก' },
  { id: 'monkey', name: 'ลิง' },
];

// ---------- โหลดค่าคงที่ของเกมจากฐานข้อมูล (ปรับได้โดยไม่ต้องแก้โค้ด) ----------
let configCache = null;
let configCacheAt = 0;
const CONFIG_CACHE_MS = 60 * 1000; // แคช 1 นาที กันยิง query ถี่เกินไป

async function getConfig() {
  if (configCache && Date.now() - configCacheAt < CONFIG_CACHE_MS) return configCache;
  const { data } = await supabase.from('pet_game_config').select('key, value');
  const config = {};
  for (const row of data || []) config[row.key] = Number(row.value);
  configCache = config;
  configCacheAt = Date.now();
  return config;
}

// ---------- คำนวณระดับการเติบโตจาก EXP สะสม ----------
function getGrowthLevel(exp, config) {
  if (exp >= config.level4_exp) return 4;
  if (exp >= config.level3_exp) return 3;
  if (exp >= config.level2_exp) return 2;
  return 1;
}

const LEVEL_NAMES = { 1: 'วัยเด็ก', 2: 'วัยรุ่น', 3: 'โตเต็มวัย', 4: 'ระดับพิเศษ' };

// ---------- เอาสัตว์เลี้ยงของสมาชิก พร้อมคำนวณความหิวที่ลดลงตามเวลาแบบ lazy ----------
export async function getMemberPet(memberId) {
  const { data: pet } = await supabase.from('member_pets').select('*').eq('member_id', memberId).order('created_at', { ascending: true }).limit(1).maybeSingle();
  if (!pet) return null;

  const config = await getConfig();
  const hoursPassed = (Date.now() - new Date(pet.last_decay_at).getTime()) / (1000 * 60 * 60);
  const decayAmount = Math.floor(hoursPassed * config.hunger_decay_per_hour);

  let hunger = pet.hunger;
  if (decayAmount > 0) {
    hunger = Math.max(0, pet.hunger - decayAmount);
    // อัปเดตค่าจริงในฐานข้อมูลเฉพาะตอนที่มีการลดจริง กันเขียนฐานข้อมูลถี่เกินไปตอนแค่เปิดดู
    await supabase.from('member_pets').update({ hunger, last_decay_at: new Date().toISOString() }).eq('id', pet.id);
    pet.hunger = hunger;
  }

  const level = getGrowthLevel(pet.exp, config);
  return {
    ...pet,
    level,
    levelName: LEVEL_NAMES[level],
    isMaxLevel: level === 4,
    isHungry: hunger < config.hunger_notify_threshold,
    speciesName: SPECIES_LIST.find((s) => s.id === pet.species_id)?.name || pet.species_id,
  };
}

export async function createPet(memberId, speciesId, name) {
  if (!SPECIES_LIST.some((s) => s.id === speciesId)) throw new Error('พันธุ์สัตว์เลี้ยงไม่ถูกต้อง');

  const existing = await supabase.from('member_pets').select('id').eq('member_id', memberId).maybeSingle();
  if (existing.data) throw new Error('คุณมีสัตว์เลี้ยงอยู่แล้ว');

  const { data, error } = await supabase
    .from('member_pets')
    .insert({ member_id: memberId, species_id: speciesId, name: name || null })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ---------- คำนวณ EXP ที่ได้จริง (รวมโบนัสความสุขถ้าถึงเกณฑ์) ----------
function applyHappinessBonus(baseExp, happiness, config) {
  if (happiness >= config.happiness_exp_bonus_threshold) {
    return Math.round(baseExp * (1 + config.happiness_exp_bonus_percent / 100));
  }
  return baseExp;
}

// ---------- ให้อาหาร (ฟรี ไม่เสีย Point — ใช้ของพื้นฐานประจำวัน) ----------
export async function feedPet(memberId) {
  const pet = await getMemberPet(memberId);
  if (!pet) throw new Error('ยังไม่มีสัตว์เลี้ยง');

  const config = await getConfig();
  const expGained = applyHappinessBonus(config.exp_feed, pet.happiness, config);

  const newHunger = Math.min(100, pet.hunger + config.hunger_feed);
  const newHappiness = Math.min(100, pet.happiness + config.happiness_feed);
  const newExp = pet.exp + expGained;

  await supabase
    .from('member_pets')
    .update({ hunger: newHunger, happiness: newHappiness, exp: newExp })
    .eq('id', pet.id);
  await supabase.from('member_pet_activity_log').insert({ member_pet_id: pet.id, activity_type: 'feed' });

  await checkAndAwardBadges(pet.id, config, newExp);
  return { expGained, newHunger, newHappiness, newExp };
}

// ---------- เล่นด้วย (ฟรี แต่จำกัดวันละ 1 ครั้ง กันสแปม) ----------
export async function playWithPet(memberId) {
  const pet = await getMemberPet(memberId);
  if (!pet) throw new Error('ยังไม่มีสัตว์เลี้ยง');

  const todayStr = new Date().toISOString().slice(0, 10);
  if (pet.last_played_at === todayStr) {
    throw new Error('วันนี้เล่นกับสัตว์เลี้ยงไปแล้ว พรุ่งนี้มาเล่นใหม่นะ');
  }

  const config = await getConfig();
  const expGained = applyHappinessBonus(config.exp_play, pet.happiness, config);
  const newExp = pet.exp + expGained;

  await supabase.from('member_pets').update({ exp: newExp, last_played_at: todayStr }).eq('id', pet.id);
  await supabase.from('member_pet_activity_log').insert({ member_pet_id: pet.id, activity_type: 'play' });

  await checkAndAwardBadges(pet.id, config, newExp);
  return { expGained, newExp };
}

// ---------- ให้ขนม (เสีย Point ซื้อจากร้านค้า) ----------
export async function giveTreat(memberId, shopItemId) {
  const pet = await getMemberPet(memberId);
  if (!pet) throw new Error('ยังไม่มีสัตว์เลี้ยง');

  const { data: item } = await supabase.from('pet_shop_items').select('*').eq('id', shopItemId).eq('active', true).maybeSingle();
  if (!item || !['food', 'treat'].includes(item.item_type)) throw new Error('ไม่พบไอเทมนี้');

  // เช็ค Point คงเหลือ — ใช้สูตรเดียวกับระบบแลกของรางวัลจริงเป๊ะๆ กันใช้แต้มซ้ำ
  const pointBalance = await getSpendableBalance(memberId);
  if (pointBalance < item.points_cost) throw new Error('Point ไม่พอ');

  const config = await getConfig();
  const expGained = applyHappinessBonus(config.exp_treat, pet.happiness, config);
  const newHunger = Math.min(100, pet.hunger + item.hunger_boost);
  const newHappiness = Math.min(100, pet.happiness + item.happiness_boost);
  const newExp = pet.exp + expGained;

  // หักแต้ม (บันทึกเป็นแถวติดลบใน ledger เดิม เพื่อให้ยอดรวมถูกต้อง)
  await supabase.from('points_ledger').insert({
    member_id: memberId,
    creative_id: null,
    reward_points: -item.points_cost,
    reason: `pet_treat:${item.id}`,
    engagement_date: new Date().toISOString().slice(0, 10),
  });

  await supabase.from('member_pets').update({ hunger: newHunger, happiness: newHappiness, exp: newExp }).eq('id', pet.id);
  await supabase.from('member_pet_activity_log').insert({ member_pet_id: pet.id, activity_type: 'treat' });

  await checkAndAwardBadges(pet.id, config, newExp);
  return { expGained, newHunger, newHappiness, newExp, pointsSpent: item.points_cost };
}

// ---------- ซื้อเครื่องแต่งกาย (ไม่มีผลต่อ EXP/ความอิ่ม แค่เก็บไว้แต่งตัว) ----------
export async function buyAccessory(memberId, shopItemId) {
  const pet = await getMemberPet(memberId);
  if (!pet) throw new Error('ยังไม่มีสัตว์เลี้ยง');

  const { data: item } = await supabase.from('pet_shop_items').select('*').eq('id', shopItemId).eq('active', true).maybeSingle();
  if (!item || item.item_type !== 'accessory') throw new Error('ไม่พบไอเทมนี้');

  const pointBalance = await getSpendableBalance(memberId);
  if (pointBalance < item.points_cost) throw new Error('Point ไม่พอ');

  await supabase.from('points_ledger').insert({
    member_id: memberId,
    creative_id: null,
    reward_points: -item.points_cost,
    reason: `pet_accessory:${item.id}`,
    engagement_date: new Date().toISOString().slice(0, 10),
  });

  const { error } = await supabase.from('member_pet_inventory').insert({ member_pet_id: pet.id, shop_item_id: item.id });
  if (error) throw error;
}

export async function toggleEquip(memberId, inventoryId, equipped) {
  const pet = await getMemberPet(memberId);
  if (!pet) throw new Error('ยังไม่มีสัตว์เลี้ยง');

  await supabase.from('member_pet_inventory').update({ equipped }).eq('id', inventoryId).eq('member_pet_id', pet.id);
}

export async function getPetInventory(memberPetId) {
  const { data } = await supabase
    .from('member_pet_inventory')
    .select('*, pet_shop_items(name, image_path, item_type)')
    .eq('member_pet_id', memberPetId)
    .order('acquired_at', { ascending: false });
  return data || [];
}

export async function getShopItems(itemType) {
  let query = supabase.from('pet_shop_items').select('*').eq('active', true).order('points_cost', { ascending: true });
  if (itemType) query = query.eq('item_type', itemType);
  const { data } = await query;
  return data || [];
}

// ---------- ตรวจสอบและมอบ Badge ----------
async function checkAndAwardBadges(memberPetId, config, currentExp) {
  const { count: fedCount } = await supabase
    .from('member_pet_activity_log')
    .select('id', { count: 'exact', head: true })
    .eq('member_pet_id', memberPetId)
    .eq('activity_type', 'feed');

  const badgesToAward = [];
  if (fedCount >= 10) badgesToAward.push('fed_10');
  if (fedCount >= 100) badgesToAward.push('fed_100');
  if (currentExp >= config.level4_exp) badgesToAward.push('max_level');

  for (const badgeId of badgesToAward) {
    await supabase.from('member_pet_badges').upsert({ member_pet_id: memberPetId, badge_id: badgeId }, { onConflict: 'member_pet_id,badge_id', ignoreDuplicates: true });
  }
}

export async function getPetBadges(memberPetId) {
  const { data } = await supabase.from('member_pet_badges').select('*, pet_badges(name_th, description)').eq('member_pet_id', memberPetId);
  return data || [];
}

export { SPECIES_LIST, getConfig };
