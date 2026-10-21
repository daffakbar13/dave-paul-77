//+------------------------------------------------------------------+
//| DavePaul77Data.mq4                                               |
//| Sends closed D1 candles and bid/ask of the active pairs to the   |
//| DavePaul77 backend. Timer driven (not tick), never trades.       |
//|                                                                  |
//| Setup: Tools > Options > Expert Advisors > Allow WebRequest for  |
//| the ServerUrl below. Attach to ONE chart (any symbol/timeframe). |
//+------------------------------------------------------------------+
#property copyright "DavePaul77"
#property version   "1.00"
#property strict

input string ServerUrl       = "https://your-app.onrender.com"; // backend URL, no trailing slash
input string DataKey         = "";      // EA_DATA_KEY from the Render environment
input string SymbolSuffix    = "";      // broker suffix in this MT4, e.g. "m" for EURUSDm
input string FallbackSymbols = "AUDJPY,AUDUSD,CADJPY,CHFJPY,EURGBP,EURNZD,EURUSD,GBPJPY,NZDJPY,NZDUSD,USDCAD,USDCHF,USDJPY"; // used when the server list cannot be read
input int    HistoryBars     = 520;     // closed D1 candles sent on the first run (about 2 years)
input int    QuoteSeconds    = 60;      // bid/ask interval
input int    ListMinutes     = 30;      // refresh the pair list from the web settings
input int    RetrySeconds    = 60;      // wait after a failed send or history not ready
input int    TimeoutMs       = 30000;   // a sleeping Render free instance can take ~30-50 s to wake

string   g_symbols[];   // app names (without suffix)
datetime g_sent[];      // open time of the last closed D1 candle the server accepted
datetime g_retryAt[];   // per symbol back-off
datetime g_lastQuotes = 0;
datetime g_lastList   = 0;

//+------------------------------------------------------------------+
int OnInit()
  {
   if(StringLen(DataKey) == 0)
     {
      Alert("DavePaul77: isi parameter DataKey");
      return(INIT_PARAMETERS_INCORRECT);
     }
   EventSetTimer(5);
   RefreshList();
   return(INIT_SUCCEEDED);
  }

void OnDeinit(const int reason) { EventKillTimer(); }

void OnTick() {}

void OnTimer()
  {
   datetime now = TimeLocal();
   if(now - g_lastList >= ListMinutes * 60)
      RefreshList();
   for(int i = 0; i < ArraySize(g_symbols); i++)
      if(now >= g_retryAt[i])
         SendCandles(i);
   if(now - g_lastQuotes >= QuoteSeconds)
     {
      SendQuotes();
      g_lastQuotes = now;
     }
  }

//+------------------------------------------------------------------+
//| HTTP                                                             |
//+------------------------------------------------------------------+
int Http(const string method, const string path, const string body, string &response)
  {
   char data[];
   char result[];
   string resultHeaders;
   string headers = "Content-Type: application/json\r\nX-Api-Key: " + DataKey + "\r\n";
   if(StringLen(body) > 0)
     {
      StringToCharArray(body, data, 0, WHOLE_ARRAY, CP_UTF8);
      ArrayResize(data, ArraySize(data) - 1); // drop the terminating zero
     }
   ResetLastError();
   int code = WebRequest(method, ServerUrl + path, headers, TimeoutMs, data, result, resultHeaders);
   if(code == -1)
     {
      int err = GetLastError();
      if(err == 4060)
         Print("DavePaul77: URL belum diizinkan. Tambahkan ", ServerUrl, " di Tools > Options > Expert Advisors > Allow WebRequest");
      else
         Print("DavePaul77: WebRequest gagal, error ", err, " (", path, ")");
      return(-1);
     }
   response = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
   if(code >= 400)
      Print("DavePaul77: HTTP ", code, " ", path, " ", response);
   return(code);
  }

//+------------------------------------------------------------------+
//| Pair list: from the server, falling back to FallbackSymbols       |
//+------------------------------------------------------------------+
void RefreshList()
  {
   g_lastList = TimeLocal();
   string names[];
   string response;
   int count = 0;
   if(Http("GET", "/api/ea/mt4/symbols", "", response) == 200)
     {
      // {"symbols":["AUDJPY","AUDUSD"]}
      int open = StringFind(response, "[");
      int close = StringFind(response, "]", open);
      if(open >= 0 && close > open)
        {
         string inner = StringSubstr(response, open + 1, close - open - 1);
         StringReplace(inner, "\"", "");
         StringReplace(inner, " ", "");
         if(StringLen(inner) > 0)
            count = StringSplit(inner, ',', names);
        }
     }
   if(count == 0)
     {
      Print("DavePaul77: daftar pair dari server tidak terbaca, memakai FallbackSymbols");
      string fallback = FallbackSymbols;
      StringReplace(fallback, " ", "");
      count = StringSplit(fallback, ',', names);
     }

   // keep progress for pairs that stay in the list
   string   oldSymbols[];
   datetime oldSent[];
   ArrayCopy(oldSymbols, g_symbols);
   ArrayCopy(oldSent, g_sent);
   ArrayResize(g_symbols, count);
   ArrayResize(g_sent, count);
   ArrayResize(g_retryAt, count);
   for(int i = 0; i < count; i++)
     {
      g_symbols[i] = names[i];
      g_sent[i] = 0;
      g_retryAt[i] = 0;
      for(int j = 0; j < ArraySize(oldSymbols); j++)
         if(oldSymbols[j] == names[i])
            g_sent[i] = oldSent[j];
      if(!SymbolSelect(names[i] + SymbolSuffix, true))
         Print("DavePaul77: ", names[i] + SymbolSuffix, " tidak ada di MT4 ini. Cek nama atau SymbolSuffix.");
     }
   Print("DavePaul77: ", count, " pair aktif");
  }

//+------------------------------------------------------------------+
//| Closed D1 candles                                                |
//+------------------------------------------------------------------+
string Num(const double v, const int digits) { return(DoubleToString(v, digits)); }

void SendCandles(const int i)
  {
   string app = g_symbols[i];
   string broker = app + SymbolSuffix;
   ResetLastError();
   int bars = iBars(broker, PERIOD_D1);
   datetime lastClosed = iTime(broker, PERIOD_D1, 1);
   int err = GetLastError();
   if(bars < 3 || lastClosed == 0 || err == 4066) // ERR_HISTORY_WILL_UPDATED: still downloading
     {
      g_retryAt[i] = TimeLocal() + RetrySeconds;
      return;
     }
   if(lastClosed <= g_sent[i])
      return; // nothing new today

   // first run: the whole history window; afterwards only candles after the last one sent
   int last = MathMin(bars - 1, HistoryBars);
   if(g_sent[i] > 0)
     {
      last = 0;
      while(last + 1 < bars && iTime(broker, PERIOD_D1, last + 1) > g_sent[i] && last < 50)
         last++;
     }
   if(last < 1)
      return;

   int digits = (int)MarketInfo(broker, MODE_DIGITS);
   string items = "";
   for(int shift = last; shift >= 1; shift--) // oldest first
     {
      if(StringLen(items) > 0)
         items += ",";
      items += "{\"t\":" + IntegerToString((long)iTime(broker, PERIOD_D1, shift))
               + ",\"o\":" + Num(iOpen(broker, PERIOD_D1, shift), digits)
               + ",\"h\":" + Num(iHigh(broker, PERIOD_D1, shift), digits)
               + ",\"l\":" + Num(iLow(broker, PERIOD_D1, shift), digits)
               + ",\"c\":" + Num(iClose(broker, PERIOD_D1, shift), digits) + "}";
     }
   string body = "{\"symbol\":\"" + app + "\",\"digits\":" + IntegerToString(digits)
                 + ",\"now\":" + IntegerToString((long)TimeCurrent())
                 + ",\"candles\":[" + items + "]}";
   string response;
   if(Http("POST", "/api/ea/mt4/candles", body, response) == 200)
     {
      g_sent[i] = lastClosed;
      Print("DavePaul77: ", app, " ", last, " candle D1 terkirim ", response);
     }
   else
      g_retryAt[i] = TimeLocal() + RetrySeconds;
  }

//+------------------------------------------------------------------+
//| Bid/ask of every active pair in one request                      |
//+------------------------------------------------------------------+
void SendQuotes()
  {
   string items = "";
   for(int i = 0; i < ArraySize(g_symbols); i++)
     {
      string broker = g_symbols[i] + SymbolSuffix;
      double bid = MarketInfo(broker, MODE_BID);
      double ask = MarketInfo(broker, MODE_ASK);
      if(bid <= 0 || ask <= 0)
         continue;
      int digits = (int)MarketInfo(broker, MODE_DIGITS);
      if(StringLen(items) > 0)
         items += ",";
      items += "{\"symbol\":\"" + g_symbols[i] + "\",\"bid\":" + Num(bid, digits) + ",\"ask\":" + Num(ask, digits) + "}";
     }
   if(StringLen(items) == 0)
      return;
   string response;
   Http("POST", "/api/ea/mt4/quotes", "{\"now\":" + IntegerToString((long)TimeCurrent()) + ",\"quotes\":[" + items + "]}", response);
  }
//+------------------------------------------------------------------+
