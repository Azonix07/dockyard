# Collects cafe PC health for Runbase admin (temps, power, disk, GPU).
$ErrorActionPreference = 'SilentlyContinue'

function R([double]$n, [int]$d = 1) {
  return [math]::Round($n, $d)
}

$sampledAt = (Get-Date).ToUniversalTime().ToString('o')

$cs = Get-CimInstance Win32_ComputerSystem
$cpu = Get-CimInstance Win32_Processor
$os = Get-CimInstance Win32_OperatingSystem
$model = ($cs.Manufacturer.ToString() + ' ' + $cs.Model.ToString()).Trim()
$cpuName = $cpu.Name.ToString().Trim()

$thermalC = $null
try {
  $tz = Get-CimInstance MSAcpi_ThermalZoneTemperature -Namespace root/wmi -ErrorAction Stop |
    Select-Object -First 1
  if ($null -ne $tz -and $tz.CurrentTemperature) {
    $thermalC = R ((([double]$tz.CurrentTemperature) / 10.0) - 273.15) 1
  }
} catch {}

$cpuLoad = 0
try { $cpuLoad = [int]$cpu.LoadPercentage } catch { $cpuLoad = 0 }
if ($cpuLoad -le 0) {
  try {
    $cpuLoad = [int](Get-Counter '\Processor(_Total)\% Processor Time' -ErrorAction Stop).CounterSamples[0].CookedValue
  } catch { $cpuLoad = 0 }
}

$memTotal = [double]$cs.TotalPhysicalMemory
$memFree = [double]$os.FreePhysicalMemory * 1024.0
$memUsed = $memTotal - $memFree
$memPct = 0.0
if ($memTotal -gt 0) {
  $memPct = [math]::Round(($memUsed / $memTotal) * 100.0, 1)
}

$committedPct = $null
$diskTimePct = $null
try {
  $counters = Get-Counter @(
    '\Memory\% Committed Bytes In Use',
    '\PhysicalDisk(_Total)\% Disk Time'
  ) -ErrorAction Stop
  foreach ($s in $counters.CounterSamples) {
    if ($s.Path -like '*committed*') { $committedPct = R ([double]$s.CookedValue) 1 }
    if ($s.Path -like '*disk time*') { $diskTimePct = R ([double]$s.CookedValue) 1 }
  }
} catch {}

$disks = @()
try {
  Get-PhysicalDisk -ErrorAction Stop | ForEach-Object {
    $disks += @{
      name = $_.FriendlyName.ToString()
      mediaType = $_.MediaType.ToString()
      health = $_.HealthStatus.ToString()
      status = $_.OperationalStatus.ToString()
      sizeBytes = [int64]$_.Size
    }
  }
} catch {}

$onAc = $true
$charging = $false
$discharging = $false
$batteryPct = $null
$chargeRateMw = 0
$dischargeRateMw = 0
$voltageMv = $null
$remainingMah = $null
$fullMah = $null

try {
  $batt = Get-CimInstance Win32_Battery | Select-Object -First 1
  if ($batt) { $batteryPct = [int]$batt.EstimatedChargeRemaining }
} catch {}

try {
  $battStatus = Get-CimInstance -Namespace root/wmi -ClassName BatteryStatus -ErrorAction Stop |
    Select-Object -First 1
  if ($battStatus) {
    $onAc = [bool]$battStatus.PowerOnline
    $charging = [bool]$battStatus.Charging
    $discharging = [bool]$battStatus.Discharging
    $chargeRateMw = [int]$battStatus.ChargeRate
    $dischargeRateMw = [int]$battStatus.DischargeRate
    $voltageMv = [int]$battStatus.Voltage
    $remainingMah = [int]$battStatus.RemainingCapacity
  }
} catch {}

try {
  $battFull = Get-CimInstance -Namespace root/wmi -ClassName BatteryFullChargedCapacity -ErrorAction Stop |
    Select-Object -First 1
  if ($battFull) { $fullMah = [int]$battFull.FullChargedCapacity }
} catch {}

$gpuName = $null
$gpuTemp = $null
$gpuPower = $null
$gpuUtil = 0
$gpuMemUsed = $null
$gpuMemTotal = $null
$hasGpu = $false

if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) {
  try {
    $line = (nvidia-smi --query-gpu=name,temperature.gpu,power.draw,power.limit,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits 2>$null |
      Select-Object -First 1)
    if ($line) {
      $parts = @($line -split ',' | ForEach-Object { $_.Trim() })
      if ($parts.Count -ge 7) {
        $hasGpu = $true
        $gpuName = $parts[0]
        if ($parts[1] -match '^\d') { $gpuTemp = [int]$parts[1] }
        $rawPower = 0.0
        [void][double]::TryParse($parts[2], [ref]$rawPower)
        if ($rawPower -gt 0 -and $rawPower -le 200) { $gpuPower = R $rawPower 1 }
        if ($parts[4] -match '^\d') { $gpuUtil = [int]$parts[4] }
        if ($parts[5] -match '^\d') { $gpuMemUsed = [int]$parts[5] }
        if ($parts[6] -match '^\d') { $gpuMemTotal = [int]$parts[6] }
      }
    }
  } catch {}
}

$powerSource = 'ac_estimate'
$powerWatts = 0.0
if ($discharging -and $dischargeRateMw -gt 0) {
  $powerWatts = [math]::Round(($dischargeRateMw / 1000.0), 1)
  $powerSource = 'battery_discharge'
} else {
  $cpuWatts = 12.0 + (($cpuLoad / 100.0) * 40.0)
  $gpuWatts = 0.0
  if ($null -ne $gpuPower) { $gpuWatts = [double]$gpuPower }
  elseif ($hasGpu) { $gpuWatts = 3.0 + (($gpuUtil / 100.0) * 50.0) }
  $powerWatts = [math]::Round((14.0 + $cpuWatts + $gpuWatts), 1)
  if (-not $onAc) { $powerSource = 'battery_estimate' }
  elseif ($charging) { $powerSource = 'ac_estimate_charging' }
}

$gpuObj = $null
if ($hasGpu) {
  $gpuObj = @{
    name = $gpuName
    tempC = $gpuTemp
    powerWatts = $gpuPower
    utilizationPct = $gpuUtil
    memoryUsedMiB = $gpuMemUsed
    memoryTotalMiB = $gpuMemTotal
  }
}

$result = @{
  sampledAt = $sampledAt
  available = $true
  device = @{
    model = $model
    cpu = $cpuName
    cores = [int]$cpu.NumberOfCores
    logicalProcessors = [int]$cpu.NumberOfLogicalProcessors
    ramBytes = [int64]$memTotal
  }
  temperatures = @{
    thermalZoneC = $thermalC
    gpuC = $gpuTemp
    cpuLoadPct = $cpuLoad
  }
  memory = @{
    usedBytes = [int64]$memUsed
    totalBytes = [int64]$memTotal
    usedPercent = [double]$memPct
    committedPercent = $committedPct
  }
  power = @{
    onAc = $onAc
    charging = $charging
    discharging = $discharging
    batteryPercent = $batteryPct
    watts = [double]$powerWatts
    source = $powerSource
    chargeRateMw = $chargeRateMw
    dischargeRateMw = $dischargeRateMw
    voltageMv = $voltageMv
    remainingCapacityMah = $remainingMah
    fullCapacityMah = $fullMah
    electricityRateInrPerKwh = 8.0
  }
  gpu = $gpuObj
  disks = $disks
  diskTimePercent = $diskTimePct
  clocks = @{
    currentMhz = [int]$cpu.CurrentClockSpeed
    maxMhz = [int]$cpu.MaxClockSpeed
  }
}

($result | ConvertTo-Json -Depth 6 -Compress)
