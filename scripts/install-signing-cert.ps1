# Plane Quick Dock — 사내 PC용 서명 인증서 신뢰 등록 스크립트
#
# 설치 대상 PC에서 "관리자 권한 PowerShell"로 한 번만 실행하세요:
#   powershell -ExecutionPolicy Bypass -File install-signing-cert.ps1
#
# 자체 서명 코드 서명 인증서(plane-quick-dock.cer)를
#   1) 신뢰할 수 있는 루트 인증 기관 (Root)
#   2) 신뢰할 수 있는 게시자 (TrustedPublisher)
# 에 등록해서 설치 파일의 "알 수 없는 게시자" 경고를 없앱니다.

$ErrorActionPreference = "Stop"

$certPath = Join-Path $PSScriptRoot "..\certs\plane-quick-dock.cer"
if (-not (Test-Path $certPath)) {
    # 스크립트 단독 배포 시 같은 폴더의 .cer도 허용
    $certPath = Join-Path $PSScriptRoot "plane-quick-dock.cer"
}
if (-not (Test-Path $certPath)) {
    Write-Error "plane-quick-dock.cer 파일을 찾을 수 없습니다. 스크립트와 같은 폴더에 두고 실행하세요."
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Error "관리자 권한이 필요합니다. PowerShell을 '관리자 권한으로 실행'한 뒤 다시 시도하세요."
}

Import-Certificate -FilePath $certPath -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
Import-Certificate -FilePath $certPath -CertStoreLocation Cert:\LocalMachine\TrustedPublisher | Out-Null

Write-Host "완료: Plane Quick Dock 서명 인증서가 신뢰 목록에 등록되었습니다." -ForegroundColor Green
