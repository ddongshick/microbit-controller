# 마이크로비트 실시간 튜닝 설정 가이드 (MakeCode)

이 문서는 웹앱 컨트롤러와 통신하여 자동차를 움직이고, **조종기의 슬라이더 값을 실시간으로 받아 모터(P0, P1, P2)의 속도와 방향을 즉각적으로 수정(튜닝)**하는 마이크로비트 코드를 작성하는 방법을 안내합니다.

## 1. 사전 준비 (블루투스 확장 추가)
1. [MakeCode for micro:bit](https://makecode.microbit.org/) 에 접속하여 새 프로젝트를 만듭니다.
2. 톱니바퀴 아이콘(설정) 또는 **고급(Advanced) > 확장(Extensions)** 메뉴를 클릭합니다.
3. **"bluetooth"** 를 검색하여 블루투스 확장을 추가합니다. (기존 라디오 기능이 비활성화된다는 경고 수락)
4. 톱니바퀴 아이콘 > **프로젝트 설정(Project Settings)** 으로 이동합니다.
5. `No Pairing Required: Anyone can connect via Bluetooth` (페어링 요구 안함) 옵션을 켜줍니다.

## 2. 코드 작성 (JavaScript 모드)
조종기에서 날아오는 **실시간 변수(VAR)**와 **조작 명령(UP, DOWN, A, B, C, D 등)**을 동시에 처리할 수 있도록 코드를 구성했습니다.
상단의 토글을 **JavaScript** 모드로 변경한 뒤, 아래의 코드를 모두 복사해서 덮어쓰기하고 다시 **블록(Blocks)** 모드로 돌아오세요.

```javascript
let varValue = 0
let varName = ""
let parts: string[] = []
let msg = ""

// 모터 제어용 변수 초기값 설정 (0~180)
let F_P0 = 180
let F_P1 = 0
let L_P0 = 0
let L_P1 = 0
let B_P0 = 0
let B_P1 = 180
let R_P0 = 180
let R_P1 = 180

// P2 보조 확장 서보모터용 변수 (A, B, C, D)
let A_P2 = 180
let B_P2 = 0
let C_P2 = 90
let D_P2 = 90

bluetooth.onBluetoothConnected(function () {
    basic.showIcon(IconNames.Happy)
})

bluetooth.onBluetoothDisconnected(function () {
    basic.showIcon(IconNames.Sad)
    pins.servoWritePin(AnalogPin.P0, 90)
    pins.servoWritePin(AnalogPin.P1, 90)
})

bluetooth.onUartDataReceived(serial.delimiters(Delimiters.NewLine), function () {
    msg = bluetooth.uartReadUntil(serial.delimiters(Delimiters.NewLine))
    
    if (msg.substr(0, 4) == "VAR:") {
        parts = msg.split(":") 
        varName = parts[1]
        varValue = parseFloat(parts[2])
        
        if (varName == "F_P0") {
            F_P0 = varValue
        } else if (varName == "F_P1") {
            F_P1 = varValue
        } else if (varName == "L_P0") {
            L_P0 = varValue
        } else if (varName == "L_P1") {
            L_P1 = varValue
        } else if (varName == "B_P0") {
            B_P0 = varValue
        } else if (varName == "B_P1") {
            B_P1 = varValue
        } else if (varName == "R_P0") {
            R_P0 = varValue
        } else if (varName == "R_P1") {
            R_P1 = varValue
        } else if (varName == "A_P2") {
            A_P2 = varValue
        } else if (varName == "B_P2") {
            B_P2 = varValue
        } else if (varName == "C_P2") {
            C_P2 = varValue
        } else if (varName == "D_P2") {
            D_P2 = varValue
        }
        
        basic.showIcon(IconNames.Yes)
        basic.pause(100)
        basic.clearScreen()
        
    } else if (msg == "UP") {
        pins.servoWritePin(AnalogPin.P0, F_P0)
        pins.servoWritePin(AnalogPin.P1, F_P1)
    } else if (msg == "DOWN") {
        pins.servoWritePin(AnalogPin.P0, B_P0)
        pins.servoWritePin(AnalogPin.P1, B_P1)
    } else if (msg == "LEFT") {
        pins.servoWritePin(AnalogPin.P0, L_P0)
        pins.servoWritePin(AnalogPin.P1, L_P1)
    } else if (msg == "RIGHT") {
        pins.servoWritePin(AnalogPin.P0, R_P0)
        pins.servoWritePin(AnalogPin.P1, R_P1)
    } else if (msg == "A") {
        pins.servoWritePin(AnalogPin.P2, A_P2)
    } else if (msg == "B") {
        pins.servoWritePin(AnalogPin.P2, B_P2)
    } else if (msg == "C") {
        pins.servoWritePin(AnalogPin.P2, C_P2)
    } else if (msg == "D") {
        pins.servoWritePin(AnalogPin.P2, D_P2)
    } else if (msg == "STOP") {
        pins.servoWritePin(AnalogPin.P0, 89)
        pins.servoWritePin(AnalogPin.P1, 90)
    }
})

basic.showIcon(IconNames.SmallDiamond)
bluetooth.startUartService()
pins.servoWritePin(AnalogPin.P0, 89)
pins.servoWritePin(AnalogPin.P1, 90)
pins.servoWritePin(AnalogPin.P2, 90)
```

## 3. 핵심 변경 포인트!
- A, B, C, D 버튼을 눌렀을 때 남는 `P2` 포트의 서보모터를 튜닝 패널에서 설정한 각도(`A_P2`, `B_P2` 등)로 움직이게 하는 코드가 미리 탑재되었습니다.
- 나중에 P2에 그리퍼(집게)나 로봇팔 등을 연결하시고, 조종기 웹앱의 옵션 창에서 A~D 버튼의 각도를 실시간으로 조절하시기만 하면 됩니다!
