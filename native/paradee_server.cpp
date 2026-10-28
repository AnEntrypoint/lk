// Paradee TTS HTTP server: text -> phonemes (misaki lexicon) -> ONNX (Paradee int8) -> WAV 24 kHz.
// POST /tts  {"text": "...", "speed": 1.0}  -> audio/wav
// GET  /health -> "ok"
#include <algorithm>
#include <cctype>
#include <cstdint>
#include <cstdlib>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <map>
#include <sstream>
#include <string>
#include <vector>

#include "httplib.h"
#include "json.hpp"
#include "onnxruntime_cxx_api.h"

using json = nlohmann::json;

static const int SAMPLE_RATE = 24000;
static const size_t MAX_PHONEMES = 510;

struct Lexicon {
    std::map<std::string, std::string> words;

    void load(const std::string& path) {
        std::ifstream f(path);
        json j = json::parse(f);
        for (auto& [word, value] : j.items()) {
            if (value.is_string()) {
                words.emplace(word, value.get<std::string>());
            } else if (value.is_object() && value.contains("DEFAULT") && value["DEFAULT"].is_string()) {
                words.emplace(word, value["DEFAULT"].get<std::string>());
            }
        }
    }

    const std::string* find(const std::string& w) const {
        auto it = words.find(w);
        if (it != words.end()) return &it->second;
        std::string lower = w;
        std::transform(lower.begin(), lower.end(), lower.begin(), [](unsigned char c) { return std::tolower(c); });
        it = words.find(lower);
        return it == words.end() ? nullptr : &it->second;
    }
};

// OOV words go to the espeak-ng binary named by ESPEAK_NG (cached per word).
// Without ESPEAK_NG set, they are dropped.
static std::string espeak_word(const std::string& word) {
    static std::map<std::string, std::string> cache;
    auto hit = cache.find(word);
    if (hit != cache.end()) return hit->second;

    std::string result;
    const char* bin = std::getenv("ESPEAK_NG");
    if (bin) {
        std::string cmd = std::string(bin) + " -q -v en-us --ipa=3 '" + word + "' 2>/dev/null";
        if (FILE* p = popen(cmd.c_str(), "r")) {
            char buf[256];
            while (std::fgets(buf, sizeof buf, p)) result += buf;
            pclose(p);
        }
        // Strip zero-width joiners (U+200D, bytes E2 80 8D) and whitespace espeak inserts.
        std::string clean;
        for (size_t i = 0; i < result.size(); ++i) {
            if (result.compare(i, 3, "\xE2\x80\x8D") == 0) { i += 2; continue; }
            if (std::isspace(static_cast<unsigned char>(result[i]))) continue;
            clean += result[i];
        }
        result = clean;
    }
    cache[word] = result;
    return result;
}

static std::string phonemize_sentence(const Lexicon& lex, const std::string& sentence) {
    std::string out;
    std::string word;
    auto flush = [&]() {
        if (word.empty()) return;
        std::string ps;
        if (const std::string* known = lex.find(word)) {
            ps = *known;
        } else {
            std::string letters;
            for (char c : word) if (c != '\'') letters += c;
            if (!letters.empty()) ps = espeak_word(letters);
        }
        if (!ps.empty()) {
            if (!out.empty()) out += ' ';
            out += ps;
        }
        word.clear();
    };
    for (unsigned char c : sentence) {
        if (std::isalpha(c) || c == '\'') {
            word += static_cast<char>(c);
        } else {
            flush();
        }
    }
    flush();
    return out;
}

static std::vector<std::string> split_sentences(const std::string& text) {
    std::vector<std::string> out;
    std::string cur;
    for (size_t i = 0; i < text.size(); ++i) {
        char c = text[i];
        if (c == '\n') {
            if (!cur.empty()) out.push_back(cur);
            cur.clear();
            continue;
        }
        cur += c;
        if ((c == '.' || c == '!' || c == '?') && i + 1 < text.size() && std::isspace(static_cast<unsigned char>(text[i + 1]))) {
            out.push_back(cur);
            cur.clear();
        }
    }
    if (!cur.empty()) out.push_back(cur);
    return out;
}

struct Paradee {
    Ort::Env env{ORT_LOGGING_LEVEL_WARNING, "paradee"};
    Ort::SessionOptions opts;
    std::unique_ptr<Ort::Session> session;
    std::map<std::string, int64_t> vocab;
    Lexicon lex;

    Paradee(const std::string& model, const std::string& config, const std::vector<std::string>& lexicons) {
        const char* threads = std::getenv("PARADEE_THREADS");
        opts.SetIntraOpNumThreads(threads ? std::atoi(threads) : 4);
        opts.SetInterOpNumThreads(1);
        session = std::make_unique<Ort::Session>(env, model.c_str(), opts);
        std::ifstream f(config);
        json cfg = json::parse(f);
        for (auto& [sym, id] : cfg["vocab"].items()) vocab[sym] = id.get<int64_t>();
        for (auto& p : lexicons) lex.load(p);
    }

    std::vector<float> run_phonemes(const std::string& phonemes, float speed) {
        std::vector<int64_t> ids;
        ids.push_back(0);
        for (size_t i = 0; i < phonemes.size() && ids.size() < MAX_PHONEMES + 1;) {
            // Phoneme symbols may be multi-byte UTF-8, so match the longest vocab key first.
            bool matched = false;
            for (size_t len = std::min<size_t>(4, phonemes.size() - i); len >= 1 && !matched; --len) {
                auto it = vocab.find(phonemes.substr(i, len));
                if (it != vocab.end()) {
                    ids.push_back(it->second);
                    i += len;
                    matched = true;
                }
            }
            if (!matched) ++i;
        }
        ids.push_back(0);

        std::vector<int64_t> shape_ids{1, static_cast<int64_t>(ids.size())};
        std::vector<int64_t> shape_speed{1};
        float speed_val = speed;
        auto mem = Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault);
        std::vector<Ort::Value> inputs;
        inputs.push_back(Ort::Value::CreateTensor<int64_t>(mem, ids.data(), ids.size(), shape_ids.data(), shape_ids.size()));
        inputs.push_back(Ort::Value::CreateTensor<float>(mem, &speed_val, 1, shape_speed.data(), shape_speed.size()));
        const char* in_names[] = {"input_ids", "speed"};
        Ort::AllocatorWithDefaultOptions alloc;
        auto out_name = session->GetOutputNameAllocated(0, alloc);
        const char* out_names[] = {out_name.get()};
        auto outputs = session->Run(Ort::RunOptions{nullptr}, in_names, inputs.data(), inputs.size(), out_names, 1);
        float* data = outputs[0].GetTensorMutableData<float>();
        size_t n = outputs[0].GetTensorTypeAndShapeInfo().GetElementCount();
        return std::vector<float>(data, data + n);
    }

    std::vector<float> synth(const std::string& text, float speed) {
        std::vector<float> audio;
        const size_t gap = SAMPLE_RATE / 5;  // 0.2 s between sentences
        for (const auto& sentence : split_sentences(text)) {
            std::string ps = phonemize_sentence(lex, sentence);
            if (ps.empty()) continue;
            auto chunk = run_phonemes(ps, speed);
            audio.insert(audio.end(), chunk.begin(), chunk.end());
            audio.insert(audio.end(), gap, 0.0f);
        }
        return audio;
    }
};

static std::string wav_bytes(const std::vector<float>& samples) {
    std::string out;
    auto put32 = [&](uint32_t v) { out.append(reinterpret_cast<const char*>(&v), 4); };
    auto put16 = [&](uint16_t v) { out.append(reinterpret_cast<const char*>(&v), 2); };
    uint32_t data_bytes = static_cast<uint32_t>(samples.size() * 2);
    out += "RIFF";
    put32(36 + data_bytes);
    out += "WAVEfmt ";
    put32(16);
    put16(1);
    put16(1);
    put32(SAMPLE_RATE);
    put32(SAMPLE_RATE * 2);
    put16(2);
    put16(16);
    out += "data";
    put32(data_bytes);
    for (float s : samples) {
        float c = std::max(-1.0f, std::min(1.0f, s));
        put16(static_cast<uint16_t>(static_cast<int16_t>(c * 32767.0f)));
    }
    return out;
}

int main(int argc, char** argv) {
    std::string dir = argc > 1 ? argv[1] : "models";
    int port = argc > 2 ? std::atoi(argv[2]) : 8790;

    Paradee tts(dir + "/paradee/paradee_int8.onnx", dir + "/paradee/config.json",
                {dir + "/misaki/us_gold.json", dir + "/misaki/us_silver.json"});

    httplib::Server svr;
    svr.Get("/health", [](const httplib::Request&, httplib::Response& res) { res.set_content("ok", "text/plain"); });
    svr.Post("/tts", [&](const httplib::Request& req, httplib::Response& res) {
        try {
            json body = json::parse(req.body);
            std::string text = body.value("text", "");
            float speed = body.value("speed", 1.0f);
            speed = std::max(0.5f, std::min(2.0f, speed));
            if (text.empty()) {
                res.status = 400;
                res.set_content("{\"error\":\"text required\"}", "application/json");
                return;
            }
            auto audio = tts.synth(text, speed);
            res.set_content(wav_bytes(audio), "audio/wav");
        } catch (const std::exception& e) {
            res.status = 500;
            res.set_content(json{{"error", e.what()}}.dump(), "application/json");
        }
    });

    std::printf("paradee listening on 127.0.0.1:%d\n", port);
    svr.listen("127.0.0.1", port);
    return 0;
}
