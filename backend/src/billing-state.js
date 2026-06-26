// คำนวณสถานะบิลลิ่งของร้านจากวันหมดรอบ + trial + grace (ใช้ร่วม: admin, bootstrap, guard)
// states: trial | active | expiring | grace | readonly | suspended
const GRACE_DAYS = Number(process.env.GRACE_DAYS) || 5;
const DAY = 86400000;

function computeBillingState(shopStatus, sub, trialEndsAt, now = Date.now()) {
  if (shopStatus === 'suspended') return { state: 'suspended', daysLeft: null };
  const end = sub && sub.current_period_end ? new Date(sub.current_period_end) : null;
  // ยังไม่เคยจ่าย / ไม่มีวันหมดรอบ → ดู trial
  if (!sub || ['trial', 'trialing'].includes(sub.status || '') || !end) {
    if (trialEndsAt) {
      const dl = Math.ceil((new Date(trialEndsAt) - now) / DAY);
      if (dl >= 0) return { state: 'trial', daysLeft: dl };
      return { state: (-dl) <= GRACE_DAYS ? 'grace' : 'readonly', daysLeft: dl };
    }
    return { state: 'trial', daysLeft: null }; // ร้านเก่าไม่ตั้ง trial_ends_at → ไม่ล็อก
  }
  const dl = Math.ceil((end - now) / DAY);
  if (dl >= 0) return { state: dl <= 7 ? 'expiring' : 'active', daysLeft: dl };
  return { state: (-dl) <= GRACE_DAYS ? 'grace' : 'readonly', daysLeft: dl };
}

// readonly/suspended = ใช้งานเขียนไม่ได้
function isWriteBlocked(state) { return state === 'readonly' || state === 'suspended'; }

module.exports = { computeBillingState, isWriteBlocked, GRACE_DAYS };
