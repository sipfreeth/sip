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

// ---------- เอาสัตว์เลี้ยงของสมาชิก พร้อมคำนวณความหิว/ความสุขที่ลดลงตามเวลาแบบ lazy + ตรวจสถานะป่วย ----------
export async function getMemberPet(memberId) {
  const { data: pet } = await supabase.from('member_pets').select('*').eq('member_id', memberId).order('created_at', { ascending: true }).limit(1).maybeSingle();
  if (!pet) return null;

  const config = await getConfig();
  const hoursPassed = (Date.now() - new Date(pet.last_decay_at).getTime()) / (1000 * 60 * 60);
  const hungerDecay = Math.floor(hoursPassed * config.hunger_decay_per_hour);
  const happinessDecay = Math.floor(hoursPassed * (config.happiness_decay_per_hour || 0));

  let hunger = pet.hunger;
  let happiness = pet.happiness;
  let isSick = pet.is_sick;

  if (hungerDecay > 0 || happinessDecay > 0) {
    hunger = Math.max(0, pet.hunger - hungerDecay);
    happiness = Math.max(0, pet.happiness - happinessDecay);

    // ป่วย = หิวและเศร้าเหลือ 0% พร้อมกัน — หายได้ด้วยยาเท่านั้น (ไม่หายเองแค่ค่าขึ้นจากการให้อาหาร)
    if ((hunger === 0 || happiness === 0) && !isSick) {
      isSick = true;
    }

    // อัปเดตค่าจริงในฐานข้อมูลเฉพาะตอนที่มีการลดจริง กันเขียนฐานข้อมูลถี่เกินไปตอนแค่เปิดดู
    await supabase.from('member_pets').update({ hunger, happiness, is_sick: isSick, last_decay_at: new Date().toISOString() }).eq('id', pet.id);
    pet.hunger = hunger;
    pet.happiness = happiness;
    pet.is_sick = isSick;
  }

  const level = getGrowthLevel(pet.exp, config);
  return {
    ...pet,
    level,
    levelName: LEVEL_NAMES[level],
    isMaxLevel: level === 4,
    isHungry: hunger < config.hunger_notify_threshold,
    isSick,
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

// ---------- เล่นด้วย (ฟรี แต่จำกัดวันละ 1 ครั้ง กันสแปม) ----------
export async function playWithPet(memberId) {
  const pet = await getMemberPet(memberId);
  if (!pet) throw new Error('ยังไม่มีสัตว์เลี้ยง');
  if (pet.isSick) throw new Error('สัตว์เลี้ยงป่วยอยู่ เล่นด้วยไม่ได้ตอนนี้ ต้องใช้ยารักษาให้หายก่อน');

  const todayStr = new Date().toISOString().slice(0, 10);
  if (pet.last_played_at === todayStr) {
    throw new Error('วันนี้เล่นกับสัตว์เลี้ยงไปแล้ว พรุ่งนี้มาเล่นใหม่นะ');
  }

  const config = await getConfig();
  const newHappiness = Math.min(100, pet.happiness + (config.happiness_play || 0));

  await supabase.from('member_pets').update({ happiness: newHappiness, last_played_at: todayStr }).eq('id', pet.id);
  await supabase.from('member_pet_activity_log').insert({ member_pet_id: pet.id, activity_type: 'play' });

  return { newHappiness, newExp: pet.exp };
}

// ---------- ซื้อไอเทมจากร้านค้า (ทุกประเภท) — เข้ากระเป๋าเสมอ ไม่ได้ใช้ทันที ต้องมากดใช้เองทีหลัง ----------
export async function buyItem(memberId, shopItemId) {
  const pet = await getMemberPet(memberId);
  if (!pet) throw new Error('ยังไม่มีสัตว์เลี้ยง');

  const { data: item } = await supabase.from('pet_shop_items').select('*').eq('id', shopItemId).eq('active', true).maybeSingle();
  if (!item) throw new Error('ไม่พบไอเทมนี้');

  const pointBalance = await getSpendableBalance(memberId);
  if (pointBalance < item.points_cost) throw new Error('Point ไม่พอ');

  await supabase.from('points_ledger').insert({
    member_id: memberId,
    creative_id: null,
    reward_points: -item.points_cost,
    reason: `pet_item:${item.id}`,
    engagement_date: new Date().toISOString().slice(0, 10),
  });

  // ซื้อไอเทมเดิมซ้ำ = บวกจำนวนเข้าแถวเดิม (ไม่สร้างแถวใหม่) — ใช้ unique constraint (member_pet_id, shop_item_id) เป็นตัวกันซ้ำ
  const { data: existing } = await supabase
    .from('member_pet_inventory')
    .select('id, quantity')
    .eq('member_pet_id', pet.id)
    .eq('shop_item_id', item.id)
    .maybeSingle();

  if (existing) {
    await supabase.from('member_pet_inventory').update({ quantity: existing.quantity + 1 }).eq('id', existing.id);
  } else {
    const { error } = await supabase.from('member_pet_inventory').insert({ member_pet_id: pet.id, shop_item_id: item.id, quantity: 1 });
    if (error) throw error;
  }
}

// ---------- ใช้ไอเทมจากกระเป๋า (อาหาร/ขนม) — วิธีเดียวที่ให้อาหารสัตว์เลี้ยงได้ตอนนี้ ----------
export async function useInventoryItem(memberId, inventoryId) {
  const pet = await getMemberPet(memberId);
  if (!pet) throw new Error('ยังไม่มีสัตว์เลี้ยง');

  const { data: invRow } = await supabase
    .from('member_pet_inventory')
    .select('*, pet_shop_items(*)')
    .eq('id', inventoryId)
    .eq('member_pet_id', pet.id)
    .maybeSingle();

  if (!invRow || invRow.quantity < 1) throw new Error('ไม่พบไอเทมนี้ในกระเป๋า');
  const item = invRow.pet_shop_items;

  // ---------- ยารักษา — ใช้ได้แค่ตอนป่วยเท่านั้น เป็นวิธีเดียวที่หายป่วยได้ ----------
  if (item.item_type === 'medicine') {
    if (!pet.isSick) throw new Error('สัตว์เลี้ยงไม่ได้ป่วยตอนนี้ ไม่จำเป็นต้องใช้ยา');

    const newHunger = Math.min(100, pet.hunger + item.hunger_boost);
    const newHappiness = Math.min(100, pet.happiness + item.happiness_boost);

    await supabase.from('member_pets').update({ hunger: newHunger, happiness: newHappiness, is_sick: false }).eq('id', pet.id);
    await supabase.from('member_pet_activity_log').insert({ member_pet_id: pet.id, activity_type: 'medicine' });

    if (invRow.quantity <= 1) {
      await supabase.from('member_pet_inventory').delete().eq('id', invRow.id);
    } else {
      await supabase.from('member_pet_inventory').update({ quantity: invRow.quantity - 1 }).eq('id', invRow.id);
    }

    return { expGained: 0, newHunger, newHappiness, newExp: pet.exp, cured: true, itemName: item.name };
  }

  if (!['food', 'treat'].includes(item.item_type)) throw new Error('ไอเทมนี้ใช้ให้อาหารไม่ได้');

  // อาหารได้แค่ความอิ่มอย่างเดียว (ไม่สนใจ happiness_boost ที่ตั้งไว้แม้จะมีค่าก็ตาม) — ขนมได้ทั้งความอิ่มและความสุข
  // EXP ไม่ได้จากการให้อาหาร/ขนมอีกต่อไปแล้ว มาจากการสแกน QR เท่านั้น
  const newHunger = Math.min(100, pet.hunger + item.hunger_boost);
  const newHappiness = item.item_type === 'treat' ? Math.min(100, pet.happiness + item.happiness_boost) : pet.happiness;

  await supabase.from('member_pets').update({ hunger: newHunger, happiness: newHappiness }).eq('id', pet.id);
  await supabase.from('member_pet_activity_log').insert({ member_pet_id: pet.id, activity_type: item.item_type === 'treat' ? 'treat' : 'feed' });

  // ใช้ไปแล้ว 1 ชิ้น หมดแล้วลบแถวทิ้ง
  if (invRow.quantity <= 1) {
    await supabase.from('member_pet_inventory').delete().eq('id', invRow.id);
  } else {
    await supabase.from('member_pet_inventory').update({ quantity: invRow.quantity - 1 }).eq('id', invRow.id);
  }

  return { newHunger, newHappiness, newExp: pet.exp, itemName: item.name };
}

// ---------- สวม/ถอดเครื่องแต่งกาย — สวมได้ทีละ 1 ชิ้นต่อ Slot (สวมชิ้นใหม่ = ถอดชิ้นเดิมใน Slot เดียวกันอัตโนมัติ) ----------
export async function toggleEquip(memberId, inventoryId, equipped) {
  const pet = await getMemberPet(memberId);
  if (!pet) throw new Error('ยังไม่มีสัตว์เลี้ยง');

  const { data: invRow } = await supabase
    .from('member_pet_inventory')
    .select('*, pet_shop_items(item_type, accessory_slot)')
    .eq('id', inventoryId)
    .eq('member_pet_id', pet.id)
    .maybeSingle();

  if (!invRow) throw new Error('ไม่พบไอเทมนี้');
  if (invRow.pet_shop_items?.item_type !== 'accessory') throw new Error('ไอเทมนี้ไม่ใช่เครื่องแต่งกาย');

  if (equipped && invRow.pet_shop_items.accessory_slot) {
    // ถอดชิ้นอื่นที่อยู่ Slot เดียวกันออกก่อน (สวมได้ทีละ 1 ชิ้นต่อ Slot)
    const { data: sameSlotItems } = await supabase
      .from('member_pet_inventory')
      .select('id, pet_shop_items!inner(accessory_slot)')
      .eq('member_pet_id', pet.id)
      .eq('equipped', true)
      .eq('pet_shop_items.accessory_slot', invRow.pet_shop_items.accessory_slot);

    for (const row of sameSlotItems || []) {
      if (row.id !== inventoryId) {
        await supabase.from('member_pet_inventory').update({ equipped: false }).eq('id', row.id);
      }
    }
  }

  await supabase.from('member_pet_inventory').update({ equipped }).eq('id', inventoryId).eq('member_pet_id', pet.id);
}

// กระเป๋า — อาหาร/ขนม/อาหารเสริม ที่ยังไม่ได้ใช้ (มีจำนวนเหลือ)
export async function getPetBag(memberPetId) {
  const { data } = await supabase
    .from('member_pet_inventory')
    .select('*, pet_shop_items!inner(name, image_path, item_type)')
    .eq('member_pet_id', memberPetId)
    .in('pet_shop_items.item_type', ['food', 'treat', 'supplement', 'medicine'])
    .order('acquired_at', { ascending: false });
  return data || [];
}

// ตู้เสื้อผ้า — เครื่องแต่งกายที่ครอบครองทั้งหมด
export async function getPetCloset(memberPetId) {
  const { data } = await supabase
    .from('member_pet_inventory')
    .select('*, pet_shop_items!inner(name, image_path, item_type, accessory_slot)')
    .eq('member_pet_id', memberPetId)
    .eq('pet_shop_items.item_type', 'accessory')
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

// ---------- ให้ EXP จากการสแกน QR (เงื่อนไขเดียวกับ Tier Score — เรียกจาก callback.js ตอนให้ Tier Score) ----------
// ป่วยอยู่ = ไม่ได้ EXP จากการสแกนเช่นกัน ต้องรักษาให้หายก่อน
export async function addPetExpFromScan(memberId) {
  const pet = await getMemberPet(memberId);
  if (!pet) return; // ยังไม่มีสัตว์เลี้ยง ไม่ต้องทำอะไร
  if (pet.isSick) return;

  const config = await getConfig();
  const expGained = Number(config.exp_per_scan || 1);
  const newExp = pet.exp + expGained;

  await supabase.from('member_pets').update({ exp: newExp }).eq('id', pet.id);
  await checkAndAwardBadges(pet.id, config, newExp);
}

export { SPECIES_LIST, getConfig };
