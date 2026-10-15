// Chrome native messaging host：密码库密钥存 macOS 钥匙串，取出前必须通过 Touch ID（或登录密码）验证。
// 协议：stdin/stdout 各一条消息，4 字节小端长度 + UTF-8 JSON。
import Foundation
import LocalAuthentication
import Security

let service = "com.bit.timestamp_vault"
let keyAccount = "vault-key"
// 指纹增删后 stateHash 会变；不一致就作废已存密钥，避免新录入的指纹直接解锁
let biometryAccount = "biometry-state"

func readMessage() -> [String: Any]? {
    let input = FileHandle.standardInput
    let header = input.readData(ofLength: 4)
    guard header.count == 4 else { return nil }
    let length = header.withUnsafeBytes { UInt32(littleEndian: $0.loadUnaligned(as: UInt32.self)) }
    guard length > 0, length < 1 << 20 else { return nil }
    let body = input.readData(ofLength: Int(length))
    return (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
}

func send(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
    var length = UInt32(data.count).littleEndian
    FileHandle.standardOutput.write(Data(bytes: &length, count: 4))
    FileHandle.standardOutput.write(data)
}

func baseQuery(_ account: String) -> [String: Any] {
    [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: account,
    ]
}

func keychainSet(_ account: String, _ data: Data) -> OSStatus {
    SecItemDelete(baseQuery(account) as CFDictionary)
    var query = baseQuery(account)
    query[kSecValueData as String] = data
    query[kSecAttrLabel as String] = "时间戳转化 密码库 (\(account))"
    return SecItemAdd(query as CFDictionary, nil)
}

func keychainGet(_ account: String) -> Data? {
    var query = baseQuery(account)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: AnyObject?
    guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess else { return nil }
    return result as? Data
}

func keychainClear() {
    SecItemDelete(baseQuery(keyAccount) as CFDictionary)
    SecItemDelete(baseQuery(biometryAccount) as CFDictionary)
}

func biometryState() -> Data? {
    let context = LAContext()
    var error: NSError?
    guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) else { return nil }
    return context.domainState.biometry.stateHash
}

// .deviceOwnerAuthentication：没有可用指纹（合盖外接显示器）时退回登录密码
func authenticate(_ reason: String) -> String? {
    let context = LAContext()
    var error: NSError?
    guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
        return "无法进行系统认证: \(error?.localizedDescription ?? "unknown")"
    }
    let done = DispatchSemaphore(value: 0)
    var failure: String? = "认证未完成"
    context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { ok, err in
        failure = ok ? nil : (err?.localizedDescription ?? "认证失败")
        done.signal()
    }
    done.wait()
    return failure
}

func handle(_ message: [String: Any]) -> [String: Any] {
    switch message["cmd"] as? String {
    case "status":
        return ["ok": true, "enrolled": keychainGet(keyAccount) != nil, "biometry": biometryState() != nil]
    case "store":
        guard let b64 = message["key"] as? String, let key = Data(base64Encoded: b64), key.count == 32 else {
            return ["ok": false, "error": "密钥格式错误"]
        }
        if let failure = authenticate("启用 Touch ID 解锁密码库") { return ["ok": false, "error": failure] }
        let status = keychainSet(keyAccount, key)
        guard status == errSecSuccess else { return ["ok": false, "error": "写入钥匙串失败 (\(status))"] }
        if let state = biometryState() { _ = keychainSet(biometryAccount, state) }
        return ["ok": true]
    case "retrieve":
        guard let key = keychainGet(keyAccount) else { return ["ok": false, "error": "未启用 Touch ID 解锁", "notEnrolled": true] }
        if let saved = keychainGet(biometryAccount), let current = biometryState(), saved != current {
            keychainClear()
            return ["ok": false, "error": "指纹已变更，请用主密码解锁后重新启用 Touch ID", "notEnrolled": true]
        }
        if let failure = authenticate("解锁密码库") { return ["ok": false, "error": failure] }
        return ["ok": true, "key": key.base64EncodedString()]
    case "clear":
        keychainClear()
        return ["ok": true]
    default:
        return ["ok": false, "error": "unknown cmd"]
    }
}

if let message = readMessage() {
    send(handle(message))
} else {
    send(["ok": false, "error": "bad message"])
}
