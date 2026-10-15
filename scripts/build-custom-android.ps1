param(
    [ValidateSet('arm64-v8a', 'x86_64')]
    [string]$Architecture = 'arm64-v8a',
    [string]$SigningScript = (Join-Path $env:USERPROFILE '.t3-custom-build/android/sign-custom-apk.ps1'),
    [string]$GoogleServicesFile = $env:T3CODE_ANDROID_GOOGLE_SERVICES_FILE
)

# Windows sideload build. Requires installed dependencies, JDK 21 and the Android SDK.
# Run from any directory: powershell -File scripts/build-custom-android.ps1
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$mobileRoot = Join-Path $repoRoot 'apps/mobile'
$androidRoot = Join-Path $mobileRoot 'android'
$toolsDir = Join-Path $env:LOCALAPPDATA 'T3Code/build-tools/ninja-1.13.2'
$envNames = @('APP_VARIANT', 'CI', 'NODE_ENV', 'JAVA_HOME', 'ANDROID_HOME', 'EXPO_NO_GIT_STATUS', 'T3CODE_ANDROID_GOOGLE_SERVICES_FILE')
$savedEnv = @{}
foreach ($name in $envNames) { $savedEnv[$name] = [Environment]::GetEnvironmentVariable($name) }

function Invoke-BuildCommand {
    param([string]$Executable, [string[]]$CommandArgs)
    & $Executable @CommandArgs
    if ($LASTEXITCODE -ne 0) {
        throw "$Executable failed with exit code $LASTEXITCODE"
    }
}

Push-Location $mobileRoot
try {
    if (!(Test-Path -LiteralPath $SigningScript -PathType Leaf)) {
        throw "Custom signing script is required to preserve installed-app compatibility: $SigningScript"
    }
    if (!$env:JAVA_HOME) {
        $javaCommand = (Get-Command java -ErrorAction Stop).Source
        $env:JAVA_HOME = Split-Path (Split-Path $javaCommand -Parent) -Parent
    }
    if (!$env:ANDROID_HOME) {
        $env:ANDROID_HOME = if ($env:ANDROID_SDK_ROOT) {
            $env:ANDROID_SDK_ROOT
        } else {
            Join-Path $env:LOCALAPPDATA 'Android/Sdk'
        }
    }
    if (!(Test-Path (Join-Path $env:ANDROID_HOME 'platform-tools/adb.exe'))) {
        throw 'Install the Android SDK and set ANDROID_HOME before building.'
    }
    $env:APP_VARIANT = 'custom'
    $env:CI = '1'
    $env:NODE_ENV = 'production'
    $env:EXPO_NO_GIT_STATUS = '1'

    if (!$GoogleServicesFile) {
        $localFirebaseConfig = Join-Path $env:USERPROFILE '.t3-custom-build/firebase/google-services.json'
        if (Test-Path -LiteralPath $localFirebaseConfig -PathType Leaf) {
            $GoogleServicesFile = $localFirebaseConfig
        }
    }
    if ($GoogleServicesFile) {
        $firebaseConfig = Get-Content -LiteralPath $GoogleServicesFile -Raw | ConvertFrom-Json
        if ('com.t3tools.t3code.custom' -notin @($firebaseConfig.client.client_info.android_client_info.package_name)) {
            throw 'Firebase configuration must include com.t3tools.t3code.custom.'
        }
        $env:T3CODE_ANDROID_GOOGLE_SERVICES_FILE = (Resolve-Path -LiteralPath $GoogleServicesFile).Path
    }

    # The SDK's Ninja 1.10 cannot handle pnpm's long native dependency paths.
    # Keep the replacement local to this build instead of modifying the Android SDK.
    New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null
    $archive = Join-Path $toolsDir 'ninja-win.zip'
    if (!(Test-Path -LiteralPath $archive)) {
        Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/ninja-build/ninja/releases/download/v1.13.2/ninja-win.zip' -OutFile $archive
    }
    $expectedHash = '07FC8261B42B20E71D1720B39068C2E14FFCEE6396B76FB7A795FB460B78DC65'
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $expectedHash) {
        throw "Unexpected Ninja archive checksum: $archive"
    }
    Expand-Archive -LiteralPath $archive -DestinationPath $toolsDir -Force
    $ninjaPath = (Join-Path $toolsDir 'ninja.exe').Replace('\', '/')
    $initScript = Join-Path $toolsDir 'android-ninja.gradle'
    @'
gradle.beforeProject { project ->
    project.plugins.withId('com.facebook.react') {
        project.extensions.getByName('react').extraPackagerArgs.addAll(['--max-workers', '2'])
    }
    ['com.android.application', 'com.android.library'].each { plugin ->
        project.plugins.withId(plugin) {
            project.android.defaultConfig.externalNativeBuild.cmake.arguments.add('-DCMAKE_MAKE_PROGRAM=__NINJA__')
        }
    }
}
'@.Replace('__NINJA__', $ninjaPath) | Set-Content -LiteralPath $initScript

    # Expo regenerates this directory. Refuse to overwrite tracked native sources
    # or a directory link that could resolve outside this checkout.
    $trackedNative = & git -C $repoRoot ls-files -- apps/mobile/android
    if ($LASTEXITCODE -ne 0 -or $trackedNative) { throw 'Android native sources must be untracked.' }
    if ((Test-Path -LiteralPath $androidRoot) -and
        ((Get-Item -LiteralPath $androidRoot).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Refusing to regenerate linked native directory: $androidRoot"
    }
    Invoke-BuildCommand 'vp' @('exec', 'expo', 'prebuild', '--platform', 'android', '--no-install')

    Set-Location $androidRoot
    # Short-lived build workers release generated JARs before the next prebuild.
    $gradleArgs = @("-PreactNativeArchitectures=$Architecture", '-Pkotlin.compiler.execution.strategy=in-process', '--no-daemon', '--console=plain', '--max-workers=2', '--init-script', $initScript)
    # Finish Metro/Hermes before the memory-intensive native build and R8 tasks.
    Invoke-BuildCommand '.\gradlew.bat' (@(':app:createBundleReleaseJsAndAssets') + $gradleArgs)
    Invoke-BuildCommand '.\gradlew.bat' (@(':app:assembleRelease') + $gradleArgs)

    $outputDir = Join-Path $repoRoot 'dist'
    New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
    $apk = Join-Path $outputDir "T3-Code-Custom-$Architecture.apk"
    # Expo's generated release build uses a debug certificate. Re-sign with the
    # persistent custom key so Android can update the app without deleting data.
    $signedApk = Join-Path $env:TEMP ("t3-custom-signed-" + [Guid]::NewGuid().ToString('N') + '.apk')
    try {
        Invoke-BuildCommand 'powershell' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $SigningScript,
            '-InputApk', (Join-Path $androidRoot 'app/build/outputs/apk/release/app-release.apk'), '-OutputApk', $signedApk)
        Copy-Item -LiteralPath $signedApk -Destination $apk -Force
    } finally {
        if (Test-Path -LiteralPath $signedApk) { Remove-Item -LiteralPath $signedApk }
        if (Test-Path -LiteralPath "$signedApk.idsig") { Remove-Item -LiteralPath "$signedApk.idsig" }
    }
    Write-Output "APK: $apk"
    Get-FileHash -LiteralPath $apk -Algorithm SHA256
} finally {
    Pop-Location
    foreach ($name in $envNames) { [Environment]::SetEnvironmentVariable($name, $savedEnv[$name]) }
}
