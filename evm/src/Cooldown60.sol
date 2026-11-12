// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

contract Cooldown60 {
    string public name = "Cooldown 60s";
    string public symbol = "CD60";
    uint8 public constant decimals = 18;
    uint256 public totalSupply = 1_000_000 ether;
    address public immutable deployer;
    address public pair;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => uint256) public boughtBlock;
    mapping(address => bool) public unlocked;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor() {
        deployer = msg.sender;
        balanceOf[msg.sender] = totalSupply;
        emit Transfer(address(0), msg.sender, totalSupply);
    }

    function setPair(address p) external {
        require(msg.sender == deployer, "deployer");
        pair = p;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _move(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= value, "allowance");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - value;
        _move(from, to, value);
        return true;
    }

    function _move(address from, address to, uint256 value) internal {
        if (pair != address(0)) {
            if (from == pair) {
                boughtBlock[to] = block.number;
                unlocked[to] = false;
            } else if (to == pair && from != deployer) {
                unlocked[from] = block.number >= boughtBlock[from] + 30; // honest anti-snipe cooldown: 60 s after a buy
                require(unlocked[from], "locked");
            }
        }
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}
