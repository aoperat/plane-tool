# Plane Quick Dock — 빌드 머신용 코드 서명 인증서 생성 스크립트
#
# 새 빌드 머신을 세팅할 때 한 번 실행합니다 (관리자 권한 불필요):
#   powershell -ExecutionPolicy Bypass -File create-signing-cert.ps1
#
# CurrentUser\My 저장소에 자체 서명 코드 서명 인증서를 만들고,
# 공개 인증서(certs/plane-quick-dock.cer)를 내보낸 뒤 지문을 출력합니다.
# 출력된 지문을 src-tauri/tauri.conf.json 의
# bundle.windows.certificateThumbprint 에 넣으세요.
#
# 주의: 인증서를 새로 만들면 기존 인증서로 신뢰 등록해 둔 PC들에
# 새 .cer 를 다시 배포(install-signing-cert.ps1)해야 합니다.

$ErrorActionPreference = "Stop"

$subject = "CN=Plane Quick Dock"
$existing = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert | Where-Object { $_.Subject -eq $subject }
if ($existing) {
    Write-Host "이미 인증서가 있습니다. 지문: $($existing.Thumbprint)" -ForegroundColor Yellow
    Write-Host "새로 만들려면 먼저 삭제하세요: Remove-Item Cert:\CurrentUser\My\$($existing.Thumbprint)"
    exit 0
}

$cert = New-SelfSignedCertificate `
    -Type CodeSigningCert `
    -Subject $subject `
    -FriendlyName "Plane Quick Dock code signing" `
    -CertStoreLocation Cert:\CurrentUser\My `
    -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 `
    -NotAfter (Get-Date).AddYears(5)

$outDir = Join-Path $PSScriptRoot "..\certs"
New-Item -ItemType Directory -Force $outDir | Out-Null
Export-Certificate -Cert $cert -FilePath (Join-Path $outDir "plane-quick-dock.cer") | Out-Null

Write-Host "인증서 생성 완료" -ForegroundColor Green
Write-Host "  지문(thumbprint): $($cert.Thumbprint)"
Write-Host "  만료일: $($cert.NotAfter)"
Write-Host "  공개 인증서: certs\plane-quick-dock.cer"
Write-Host ""
Write-Host "src-tauri/tauri.conf.json 의 bundle.windows.certificateThumbprint 를 위 지문으로 갱신하세요."
