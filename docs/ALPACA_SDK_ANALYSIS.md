# Alpaca Python SDK Analysis

## 📊 Overview

فحص شامل للـ Alpaca-py SDK الرسمي وكيف نستفيد منه في Trading Extension.

---

## 🏗️ SDK Structure

```
alpaca-py/
├── alpaca/
│   ├── broker/          # Broker API (إدارة حسابات العملاء)
│   ├── common/          # مكونات مشتركة
│   ├── data/            # بيانات السوق
│   │   ├── historical/  # بيانات تاريخية
│   │   ├── live/        # بيانات لايف
│   │   └── models/      # نماذج البيانات
│   └── trading/         # تداول
│       ├── client.py    # Trading Client
│       ├── enums.py     # 22 Enums
│       ├── models.py    # Data Models
│       ├── requests.py  # Request Objects
│       └── stream.py    # WebSocket Streaming
├── examples/            # أمثلة عملية
└── tests/              # اختبارات
```

---

## ⚡ Key Features Discovered

### 1️⃣ **Order Types** (6 أنواع)
```python
class OrderType(str, Enum):
    MARKET = "market"              # فوري بسعر السوق
    LIMIT = "limit"                # بسعر محدد
    STOP = "stop"                  # Stop Loss
    STOP_LIMIT = "stop_limit"      # Stop + Limit
    TRAILING_STOP = "trailing_stop" # Trailing Stop Loss
```

**ما نستخدمه حالياً:** MARKET only ❌
**ما نحتاج نضيفه:** الـ 5 أنواع الباقية ✅

---

### 2️⃣ **Time In Force** (6 خيارات)
```python
class TimeInForce(str, Enum):
    DAY = "day"      # صالح ليوم واحد
    GTC = "gtc"      # Good Till Canceled
    OPG = "opg"      # Market/Limit on Open
    CLS = "cls"      # Market/Limit on Close
    IOC = "ioc"      # Immediate Or Cancel
    FOK = "fok"      # Fill Or Kill
```

**ما نستخدمه حالياً:** DAY only ❌
**ما نحتاج نضيفه:** جميع الخيارات ✅

---

### 3️⃣ **Order Classes** (5 أصناف)
```python
class OrderClass(str, Enum):
    SIMPLE = "simple"     # أمر بسيط
    MLEG = "mleg"         # Multi-Leg Options
    BRACKET = "bracket"   # Take Profit + Stop Loss معاً
    OCO = "oco"           # One-Cancels-Other
    OTO = "oto"           # One-Triggers-Other
```

**ما نستخدمه حالياً:** SIMPLE only ❌
**ما نحتاج نضيفه:** BRACKET, OCO, OTO للتداول المتقدم ✅

---

### 4️⃣ **Order Status** (18 حالة!)
```python
class OrderStatus(str, Enum):
    NEW = "new"
    PARTIALLY_FILLED = "partially_filled"
    FILLED = "filled"
    DONE_FOR_DAY = "done_for_day"
    CANCELED = "canceled"
    EXPIRED = "expired"
    REPLACED = "replaced"
    PENDING_CANCEL = "pending_cancel"
    PENDING_REPLACE = "pending_replace"
    PENDING_REVIEW = "pending_review"
    ACCEPTED = "accepted"
    PENDING_NEW = "pending_new"
    ACCEPTED_FOR_BIDDING = "accepted_for_bidding"
    STOPPED = "stopped"
    REJECTED = "rejected"
    SUSPENDED = "suspended"
    CALCULATED = "calculated"
    HELD = "held"
```

**ما نعرضه حالياً:** Status بس نص ❌
**ما نحتاج:** Badges ملونة لكل حالة ✅

---

### 5️⃣ **Asset Classes** (4 أنواع)
```python
class AssetClass(str, Enum):
    US_EQUITY = "us_equity"     # أسهم أمريكية
    US_OPTION = "us_option"     # Options
    CRYPTO = "crypto"            # Crypto
    CRYPTO_PERP = "crypto_perp"  # Crypto Perpetual
```

**ما ندعمه حالياً:** US_EQUITY + CRYPTO ✅
**ما نحتاج نضيف:** OPTIONS (Priority 3)

---

### 6️⃣ **Position Sides**
```python
class PositionSide(str, Enum):
    LONG = "long"   # شراء
    SHORT = "short" # بيع على المكشوف
```

**ما ندعمه:** LONG only ❌
**ما نحتاج:** SHORT selling support (متقدم)

---

### 7️⃣ **WebSocket Streaming** 🔥
```python
# من stream.py
class TradingStream:
    """Real-time trade updates via WebSocket"""
    - trade_updates (أحداث الأوامر فوراً)
    - account_updates (تحديثات الحساب فوراً)
```

**ما نستخدمه:** REST API polling ❌
**ما نحتاج:** WebSocket لتحديثات فورية ✅

---

## 🎯 Features We Should Add

### **Priority 1** (هذا الأسبوع - 8-11 ساعات)

#### 1. **Stock Search with Autocomplete** ✅
```javascript
// API endpoint نستخدمه
GET /v2/assets?status=active&asset_class=us_equity
// نضيف search parameter
GET /v2/assets?search=AAPL
```

#### 2. **Live Price Display** ✅
```javascript
// استخدام Alpaca Data API
GET /v2/stocks/{symbol}/quotes/latest
// Auto-refresh كل 5 ثواني
```

#### 3. **Order Cost Calculator** ✅
```javascript
// حساب:
// - Quantity × Price = Total
// - Commission (if any)
// - Available Buying Power check
```

#### 4. **Time in Force Options** ✅
```javascript
// إضافة Dropdown:
<select name="time_in_force">
  <option value="day">Day</option>
  <option value="gtc">GTC</option>
  <option value="ioc">IOC</option>
  <option value="fok">FOK</option>
</select>
```

#### 5. **Order Preview Dialog** ✅
```javascript
// قبل Submit → Modal يعرض:
// - Symbol + Quantity
// - Order Type + Side
// - Estimated Cost
// - Time in Force
// → Confirm / Cancel buttons
```

---

### **Priority 2** (الأسبوع القادم - 10-13 ساعات)

#### 6. **Advanced Order Types** 🔥
```javascript
// إضافة:
// - Limit Orders (سعر محدد)
// - Stop Loss Orders
// - Stop Limit Orders
// - Trailing Stop Orders

// UI: Tabs for order types
[Market] [Limit] [Stop] [Stop Limit] [Trailing]
```

#### 7. **Bracket Orders** 🔥
```javascript
// أمر واحد يشمل:
// 1. Entry Order
// 2. Take Profit (أعلى)
// 3. Stop Loss (أقل)

bracketOrder = {
  symbol: "AAPL",
  qty: 10,
  side: "buy",
  type: "market",
  order_class: "bracket",
  take_profit: { limit_price: 200 },
  stop_loss: { stop_price: 180 }
}
```

#### 8. **WebSocket Real-Time Updates** 🔥
```javascript
// بدل REST polling كل 5s
// → WebSocket connection
// → تحديثات فورية للأوامر والأسعار

const stream = new AlpacaStream(apiKey, secretKey);
stream.onTradeUpdate((update) => {
  updateOrderUI(update);
});
```

#### 9. **Enhanced Positions Table**
```javascript
// إضافة columns:
// - Cost Basis (سعر الشراء الأصلي)
// - Today's P/L (ربح/خسارة اليوم)
// - Total P/L % (نسبة مئوية)
// - Market Value graph (رسم بياني صغير)
```

---

### **Priority 3** (المستقبل - 12-16 ساعات)

#### 10. **Options Trading** 💎
```javascript
// دعم Options:
// - Calls & Puts
// - Strike Price selection
// - Expiration dates
// - Multi-leg strategies (Iron Condor, Butterfly, etc.)
```

#### 11. **News Integration**
```javascript
// Alpaca News API
GET /v1beta1/news?symbols=AAPL
// عرض الأخبار بجانب الرسم البياني
```

#### 12. **Corporate Actions**
```javascript
// تنبيهات:
// - Stock Splits
// - Dividends
// - Mergers
```

---

## 💡 Implementation Insights

### 1. **OOP Design Pattern**
```javascript
// Alpaca SDK uses Request Objects
// نستخدم نفس النمط:

class MarketOrderRequest {
  constructor(symbol, qty, side, time_in_force) {
    this.symbol = symbol;
    this.qty = qty;
    this.side = side;
    this.time_in_force = time_in_force || 'day';
  }
}

const order = new MarketOrderRequest('AAPL', 10, 'buy', 'gtc');
```

### 2. **Data Validation with Pydantic**
```javascript
// في JavaScript نستخدم Zod:
import { z } from 'zod';

const OrderSchema = z.object({
  symbol: z.string().min(1).max(10),
  qty: z.number().positive(),
  side: z.enum(['buy', 'sell']),
  type: z.enum(['market', 'limit', 'stop', 'stop_limit', 'trailing_stop']),
  time_in_force: z.enum(['day', 'gtc', 'opg', 'cls', 'ioc', 'fok'])
});
```

### 3. **Error Handling**
```javascript
// Alpaca SDK has detailed error responses
// نحسن error messages عندنا:

try {
  await submitOrder(orderData);
} catch (error) {
  if (error.code === 'insufficient_balance') {
    toast.error('Insufficient buying power');
  } else if (error.code === 'symbol_invalid') {
    toast.error('Invalid stock symbol');
  } else {
    toast.error(error.message);
  }
}
```

---

## 📊 Comparison: Current vs. Alpaca SDK

| Feature | Current Trading Extension | Alpaca SDK | Action |
|---------|---------------------------|------------|--------|
| Order Types | Market only | 5 types | ❌ Add 4 more |
| Time in Force | Day only | 6 options | ❌ Add 5 more |
| Order Classes | Simple only | 5 classes | ❌ Add Bracket, OCO, OTO |
| Real-time Updates | REST polling | WebSocket | ❌ Upgrade |
| Price Display | Static | Live quotes | ❌ Add live pricing |
| Order Status | 3 states | 18 states | ❌ Add all states |
| Position Details | Basic | Full analytics | ❌ Enhance |
| News | None | Integrated | ❌ Add news feed |
| Options | None | Full support | ⚠️ Future |
| Stock Search | None | Asset search API | ❌ Add autocomplete |

---

## 🚀 Recommended Implementation Plan

### **Week 1** (الأسبوع الأول)
1. ✅ Stock Search + Autocomplete (3 hours)
2. ✅ Live Price Display (4 hours)
3. ✅ Time in Force Options (1 hour)
4. ✅ Order Calculator (2 hours)
5. ✅ Order Preview Dialog (2 hours)

**Total: 12 hours**

---

### **Week 2** (الأسبوع الثاني)
6. ✅ Limit Orders (3 hours)
7. ✅ Stop/Stop Limit Orders (3 hours)
8. ✅ Trailing Stop Orders (2 hours)
9. ✅ Enhanced Positions Table (3 hours)
10. ✅ Position Details Modal (2 hours)

**Total: 13 hours**

---

### **Week 3** (الأسبوع الثالث)
11. ✅ WebSocket Integration (4 hours)
12. ✅ Bracket Orders (3 hours)
13. ✅ OCO/OTO Orders (3 hours)
14. ✅ News Feed (2 hours)
15. ✅ Analytics Dashboard (3 hours)

**Total: 15 hours**

---

## 📚 Resources

**Alpaca Docs:**
- Trading API: https://docs.alpaca.markets/reference/postorder
- Market Data: https://docs.alpaca.markets/reference/stocklatestquote
- WebSocket: https://docs.alpaca.markets/docs/websocket-streaming

**SDK Code:**
- Location: the public `alpaca-py` repository (the local copy was removed; it is not part of the app)
- Key files:
  - `alpaca/trading/enums.py` - All enums
  - `alpaca/trading/requests.py` - Request objects
  - `alpaca/trading/models.py` - Response models
  - `alpaca/trading/stream.py` - WebSocket streaming
  - `alpaca/data/historical/` - Historical data APIs

---

## ✅ Next Steps

1. **اليوم**: ابدأ Priority 1 Task #1 (Stock Search)
2. **غداً**: Tasks #2-3 (Live Price + Calculator)
3. **بعد غد**: Tasks #4-5 (Time in Force + Preview)
4. **نهاية الأسبوع**: Review + Testing

---

**Created**: 2026-02-27
**Status**: Ready for Implementation
**Estimated Total Time**: 40 hours (3 weeks)
